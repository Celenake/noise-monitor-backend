#include <Arduino.h>
#include <PDM.h>
#include <math.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFiNINA.h>

// =================== WiFi ===================
const char* WIFI_SSID = "iPhone";     // CHANGE THIS
const char* WIFI_PASS = "celena123*";    // CHANGE THIS

// =================== Backend API ===================
const char* BACKEND_URL = "noise-monitor-api.onrender.com";  // Your Render URL
const int BACKEND_PORT = 443;  // HTTPS
const char* BACKEND_PATH = "/api/noise-data";
const char* DEVICE_ID = "RP2040_003";

// =================== OLED (SSD1306) ===================
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define OLED_ADDR 0x3C
// RP2040 I2C pins are fixed - no need to set them
// SDA = A4, SCL = A5 by default

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// Graph settings
const float DB_MIN = 20.0;
const float DB_MAX = 80.0;
const uint8_t GRAPH_X = 0;
const uint8_t GRAPH_Y = 22;
const uint8_t GRAPH_W = 128;
const uint8_t GRAPH_H = 42;

float ringBuf[SCREEN_WIDTH];
uint8_t head = 0;
float currentDb = 50.0;
const unsigned long SAMPLE_EVERY_MS = 120;
unsigned long lastDisplayMs = 0;

// =================== MIC via PDM ===================
static const char channels = 1;
static const int frequency = 16000;
short sampleBuffer[512];
volatile int samplesRead = 0;
static const float NORM_DIV = 32768.0f;
static float CAL_OFFSET_DBA = 96.0f;
static const float EPS_F = 1e-12f;

// Simple HPF
struct OnePoleHPF {
  float a = 0.995f;
  float y = 0.0f;
  float x_prev = 0.0f;
  float process(float x) {
    y = a * (y + x - x_prev);
    x_prev = x;
    return y;
  }
} hpf;

// 1s aggregation
double sumsq_1s = 0.0;
uint32_t samples_1s = 0;
uint32_t t1_start_ms = 0;

// Send queue
#define QUEUE_SIZE 5
float sendQueue[QUEUE_SIZE];
uint8_t queueHead = 0;
uint8_t queueTail = 0;
uint8_t queueCount = 0;
unsigned long backoffMs = 1000;
const unsigned long BACKOFF_MAX = 30000;
WiFiSSLClient client;

// ======== Graph Functions ========
float clampf(float v, float lo, float hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

int mapDbToY(float dB) {
  float t = (clampf(dB, DB_MIN, DB_MAX) - DB_MIN) / (DB_MAX - DB_MIN);
  int y = GRAPH_Y + GRAPH_H - 1 - (int)(t * (GRAPH_H - 1));
  return y;
}

void pushSample(float dB) {
  ringBuf[head] = dB;
  head = (head + 1) % GRAPH_W;
}

void drawGraph() {
  display.drawRect(GRAPH_X, GRAPH_Y, GRAPH_W, GRAPH_H, SSD1306_WHITE);
  const float WHO_DAY = 55.0;
  int yWho = mapDbToY(WHO_DAY);
  for (int x = GRAPH_X + 1; x < GRAPH_X + GRAPH_W - 1; x += 4) {
    display.drawPixel(x, yWho, SSD1306_WHITE);
  }
  int prevX = 0, prevY = mapDbToY(ringBuf[(head) % GRAPH_W]);
  for (int i = 1; i < GRAPH_W; i++) {
    int idx = (head + i) % GRAPH_W;
    int x = i;
    int y = mapDbToY(ringBuf[idx]);
    display.drawLine(prevX, prevY, x, y, SSD1306_WHITE);
    prevX = x;
    prevY = y;
  }
}

void drawHeader() {
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.print(currentDb, 1);
  display.print(" dB");
  int limit = 55;
  const char* label = "OK";
  if (currentDb > limit + 5) label = "HIGH";
  else if (currentDb > limit - 5) label = "CAUTION";
  int16_t x1, y1;
  uint16_t w, h;
  display.setTextSize(1);
  display.getTextBounds(label, 0, 0, &x1, &y1, &w, &h);
  display.setCursor(SCREEN_WIDTH - w - 2, 4);
  display.print(label);
}

// =================== PDM Callback ===================
void onPDMdata() {
  int bytesAvailable = PDM.available();
  PDM.read(sampleBuffer, bytesAvailable);
  samplesRead = bytesAvailable / 2;
}

// =================== Network Functions ===================
bool postToBackend(float dba) {
  if (WiFi.status() != WL_CONNECTED) return false;

  if (!client.connect(BACKEND_URL, 443)) {
    Serial.println("Connection failed!");
    return false;
  }

  String payload = "{\"dba_instant\":" + String(dba, 2) +
                   ",\"device_id\":\"" + String(DEVICE_ID) + "\"}";
  
  client.println("POST " + String(BACKEND_PATH) + " HTTP/1.1");
  client.println("Host: " + String(BACKEND_URL));
  client.println("Content-Type: application/json");
  client.print("Content-Length: ");
  client.println(payload.length());
  client.println();
  client.println(payload);

  unsigned long timeout = millis() + 3000;
  while (!client.available() && millis() < timeout) delay(10);

  bool success = false;
  if (client.available()) {
    String response = client.readString();
    if (response.indexOf("200") > 0 || response.indexOf("201") > 0) {
      Serial.print("[SEND] OK ");
      Serial.print(dba, 2);
      Serial.println(" dBA");
      success = true;
    } else {
      Serial.print("[SEND] Failed: ");
      Serial.println(response.substring(0, 50));
    }
  } else {
    Serial.println("[SEND] No response");
  }
  client.stop();
  return success;
}

bool queuePush(float value) {
  if (queueCount >= QUEUE_SIZE) return false;
  sendQueue[queueHead] = value;
  queueHead = (queueHead + 1) % QUEUE_SIZE;
  queueCount++;
  return true;
}

bool queuePop(float* value) {
  if (queueCount == 0) return false;
  *value = sendQueue[queueTail];
  queueTail = (queueTail + 1) % QUEUE_SIZE;
  queueCount--;
  return true;
}

void processSendQueue() {
  float dba;
  if (queuePop(&dba)) {
    bool ok = postToBackend(dba);
    if (!ok) {
      backoffMs = min(backoffMs * 2, BACKOFF_MAX);
      delay(backoffMs);
    } else {
      backoffMs = 1000;
    }
    while (queueCount > 1) queuePop(&dba);
  }
}

// =================== Setup Functions ===================
void initializeSerial() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nRP2040 Noise Meter -> Backend");
}

void connectToWiFi() {
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 8000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Connected! IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi not connected");
  }
}

void initializeMicrophone() {
  PDM.onReceive(onPDMdata);
  if (!PDM.begin(channels, frequency)) {
    Serial.println("Failed to start PDM!");
    while (1);
  }
  Serial.println("Microphone initialized!");
}

void initializeOLEDDisplay() {
  // On RP2040, SDA is A4, SCL is A5 by default
  Wire.begin();  // No need for setSDA/setSCL
  Wire.setClock(400000);

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("SSD1306 allocation failed");
    while (true) {}
  }

  display.clearDisplay();
  display.setCursor(0, 0);
  display.println("Noise meter init...");
  display.display();
}

void initializeRingBuffer() {
  for (int i = 0; i < GRAPH_W; i++) ringBuf[i] = 50.0;
  t1_start_ms = millis();
}

// =================== Audio Processing ===================
float calculateRMS(short* samples, int numSamples) {
  double sumSq = 0.0;
  for (int i = 0; i < numSamples; i++) {
    float s = (float)samples[i] / NORM_DIV;
    s = hpf.process(s);
    sumSq += (double)s * (double)s;
  }
  return sqrt(sumSq / (double)numSamples);
}

float convertToDecibels(float rms_value) {
  float dBFS = 20.0f * log10f(fmaxf(rms_value, EPS_F));
  return dBFS + CAL_OFFSET_DBA;
}

void updateDisplay() {
  pushSample(currentDb);
  display.clearDisplay();
  drawHeader();
  drawGraph();
  display.display();
}

void processDisplayUpdate(unsigned long now) {
  if (now - lastDisplayMs >= SAMPLE_EVERY_MS) {
    lastDisplayMs = now;
    updateDisplay();
  }
}

// =================== SETUP ===================
void setup() {
  initializeSerial();
  connectToWiFi();
  initializeMicrophone();
  initializeOLEDDisplay();
  initializeRingBuffer();
  Serial.println("Setup complete.");
}

// =================== LOOP ===================
void loop() {
  if (samplesRead > 0) {
    float rms_block = calculateRMS(sampleBuffer, samplesRead);
    currentDb = convertToDecibels(rms_block);
    
    double sumsq_block = 0.0;
    for (int i = 0; i < samplesRead; i++) {
      float s = (float)sampleBuffer[i] / NORM_DIV;
      s = hpf.process(s);
      sumsq_block += (double)s * (double)s;
    }
    
    sumsq_1s += sumsq_block;
    samples_1s += samplesRead;
    uint32_t now = millis();
    
    if (now - t1_start_ms >= 1000) {
      float rms_1s = sqrt(sumsq_1s / (double)samples_1s);
      float dBA_1s = convertToDecibels(rms_1s);
      if (!queuePush(dBA_1s)) {
        float dummy;
        queuePop(&dummy);
        queuePush(dBA_1s);
      }
      sumsq_1s = 0.0;
      samples_1s = 0;
      t1_start_ms = now;
    }
    
    samplesRead = 0;
    processDisplayUpdate(millis());
    processSendQueue();
  }
  delay(10);
}