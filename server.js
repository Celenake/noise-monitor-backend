const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Store data in memory
let readings = [];
let devices = [];

// ========== HEALTH CHECK ==========
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ========== RECEIVE DATA FROM RP2040 (POST) ==========
app.post('/api/noise-data', (req, res) => {
    console.log('📥 Received POST:', req.body);
    
    const { device_id, dba_instant } = req.body;
    
    if (!device_id) {
        return res.status(400).json({ error: 'device_id is required' });
    }
    
    if (dba_instant === undefined || dba_instant === null) {
        return res.status(400).json({ error: 'dba_instant is required' });
    }
    
    // Add device to list if new
    if (!devices.includes(device_id)) {
        devices.push(device_id);
    }
    
    // Store reading
    const reading = {
        id: readings.length + 1,
        device_id: device_id,
        dba_instant: parseFloat(dba_instant),
        timestamp: new Date()
    };
    
    readings.push(reading);
    
    // Keep only last 1000 readings
    if (readings.length > 1000) {
        readings = readings.slice(-1000);
    }
    
    console.log(`✅ Saved: ${device_id} = ${dba_instant} dB`);
    
    res.json({ 
        success: true, 
        message: 'Data received',
        data: reading
    });
});

// ========== GET LATEST READING ==========
app.get('/api/live', (req, res) => {
    const deviceId = req.query.device_id;
    
    if (!deviceId) {
        return res.status(400).json({ error: 'device_id query parameter is required' });
    }
    
    const deviceReadings = readings.filter(r => r.device_id === deviceId);
    
    if (deviceReadings.length === 0) {
        return res.status(404).json({ 
            error: 'No readings found for device',
            device_id: deviceId
        });
    }
    
    const latest = deviceReadings[deviceReadings.length - 1];
    res.json(latest);
});

// ========== GET ALL DEVICES ==========
app.get('/api/devices', (req, res) => {
    res.json({ devices: devices, count: devices.length });
});

// ========== GET HISTORY ==========
app.get('/api/history', (req, res) => {
    const deviceId = req.query.device_id;
    
    if (!deviceId) {
        return res.status(400).json({ error: 'device_id query parameter is required' });
    }
    
    const deviceReadings = readings.filter(r => r.device_id === deviceId);
    res.json({
        device_id: deviceId,
        count: deviceReadings.length,
        data: deviceReadings
    });
});

// ========== ROOT ENDPOINT ==========
app.get('/', (req, res) => {
    res.json({
        name: 'Noise Monitor API',
        version: '1.0.0',
        endpoints: {
            'GET /': 'This information',
            'GET /health': 'Check if server is alive',
            'POST /api/noise-data': 'Send noise data (requires device_id and dba_instant)',
            'GET /api/live?device_id=XXX': 'Get latest reading for a device',
            'GET /api/devices': 'List all devices that have sent data',
            'GET /api/history?device_id=XXX': 'Get all readings for a device'
        },
        stats: {
            total_readings: readings.length,
            unique_devices: devices.length
        }
    });
});

// 404 handler for unknown routes
app.use('*', (req, res) => {
    res.status(404).json({ 
        error: 'Route not found',
        message: `The endpoint ${req.method} ${req.originalUrl} does not exist`
    });
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   POST endpoint: http://localhost:${PORT}/api/noise-data`);
});