const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Store data in memory
let readings = [];

// HEALTH CHECK - Test if server is alive
app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// RECEIVE DATA FROM RP2040 - This is what your Arduino calls
app.post('/api/noise-data', (req, res) => {
    console.log('Received:', req.body);
    
    const { device_id, dba_instant } = req.body;
    
    if (!device_id || dba_instant === undefined) {
        return res.status(400).json({ error: 'Missing device_id or dba_instant' });
    }
    
    const reading = {
        id: readings.length + 1,
        device_id: device_id,
        value: dba_instant,
        time: new Date()
    };
    
    readings.push(reading);
    console.log(`✅ Saved: ${device_id} = ${dba_instant} dB`);
    
    res.json({ success: true, message: 'Data received' });
});

// GET LATEST READING
app.get('/api/live', (req, res) => {
    const deviceId = req.query.device_id;
    
    if (!deviceId) {
        return res.status(400).json({ error: 'Need device_id' });
    }
    
    const deviceReadings = readings.filter(r => r.device_id === deviceId);
    
    if (deviceReadings.length === 0) {
        return res.json({ message: 'No data yet for ' + deviceId });
    }
    
    const last = deviceReadings[deviceReadings.length - 1];
    res.json({ device_id: last.device_id, dba_instant: last.value, timestamp: last.time });
});

// GET ALL DEVICES
app.get('/api/devices', (req, res) => {
    const devices = [...new Set(readings.map(r => r.device_id))];
    res.json({ devices: devices, count: devices.length });
});

// ROOT - Show all available endpoints
app.get('/', (req, res) => {
    res.json({
        api: 'Noise Monitor',
        endpoints: {
            'GET /health': 'Check if server is alive',
            'POST /api/noise-data': 'Send noise data (requires device_id and dba_instant)',
            'GET /api/live?device_id=XXX': 'Get latest reading for a device',
            'GET /api/devices': 'List all devices'
        }
    });
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   API: http://localhost:${PORT}/`);
});