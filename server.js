const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage
let noiseReadings = [];
let devices = [];

// ========== HEALTH CHECK (MUST BE FIRST) ==========
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        message: 'Server is running!'
    });
});

// ========== DEVICE ROUTES ==========
app.get('/api/devices', (req, res) => {
    res.json(devices);
});

app.post('/api/devices', (req, res) => {
    const { device_id, label } = req.body;
    
    if (!device_id || !label) {
        return res.status(400).json({ error: 'device_id and label required' });
    }
    
    const existing = devices.find(d => d.device_id === device_id);
    if (existing) {
        return res.json(existing);
    }
    
    const newDevice = { device_id, label, created_at: new Date() };
    devices.push(newDevice);
    res.status(201).json(newDevice);
});

// ========== NOISE DATA ROUTES ==========
app.post('/api/noise-data', (req, res) => {
    const { device_id, dba_instant } = req.body;
    
    if (!device_id || dba_instant === undefined) {
        return res.status(400).json({ error: 'device_id and dba_instant required' });
    }
    
    const reading = {
        id: noiseReadings.length + 1,
        device_id,
        dba_instant: parseFloat(dba_instant),
        timestamp: new Date()
    };
    
    noiseReadings.push(reading);
    console.log(`✅ ${device_id}: ${dba_instant} dB`);
    res.status(201).json({ success: true, data: reading });
});

app.get('/api/live', (req, res) => {
    const { device_id } = req.query;
    
    if (!device_id) {
        return res.status(400).json({ error: 'device_id required' });
    }
    
    const readings = noiseReadings.filter(r => r.device_id === device_id);
    if (readings.length === 0) {
        return res.status(404).json({ error: 'No readings found' });
    }
    
    res.json(readings[readings.length - 1]);
});

app.get('/api/history', (req, res) => {
    const { device_id } = req.query;
    
    if (!device_id) {
        return res.status(400).json({ error: 'device_id required' });
    }
    
    const readings = noiseReadings.filter(r => r.device_id === device_id);
    res.json({ device_id, count: readings.length, data: readings });
});

// ========== ROOT ENDPOINT ==========
app.get('/', (req, res) => {
    res.json({
        name: 'Noise Monitor API',
        endpoints: {
            health: 'GET /health',
            devices: 'GET /api/devices',
            register: 'POST /api/devices',
            data: 'POST /api/noise-data',
            live: 'GET /api/live?device_id=XXX',
            history: 'GET /api/history?device_id=XXX'
        }
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   API root: http://localhost:${PORT}/`);
});