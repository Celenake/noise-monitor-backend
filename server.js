require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(helmet());
app.use(cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Temporary in-memory storage (for testing without database)
let noiseReadings = [];
let devices = [];

// Register a device
app.post('/api/devices', (req, res) => {
    const { device_id, label, address, latitude, longitude } = req.body;
    
    if (!device_id || !label) {
        return res.status(400).json({ error: 'device_id and label are required' });
    }
    
    const existingDevice = devices.find(d => d.device_id === device_id);
    if (existingDevice) {
        return res.json(existingDevice);
    }
    
    const newDevice = { device_id, label, address, latitude, longitude, created_at: new Date() };
    devices.push(newDevice);
    res.status(201).json(newDevice);
});

// Get all devices
app.get('/api/devices', (req, res) => {
    res.json(devices);
});

// Receive noise data from RP2040
app.post('/api/noise-data', (req, res) => {
    const { device_id, dba_instant } = req.body;
    
    if (!device_id || dba_instant === undefined) {
        return res.status(400).json({ error: 'device_id and dba_instant are required' });
    }
    
    const reading = {
        id: noiseReadings.length + 1,
        device_id,
        dba_instant: parseFloat(dba_instant),
        timestamp: new Date()
    };
    
    noiseReadings.push(reading);
    
    // Keep only last 1000 readings (to save memory)
    if (noiseReadings.length > 1000) {
        noiseReadings = noiseReadings.slice(-1000);
    }
    
    console.log(`📊 Received: ${device_id} -> ${dba_instant} dB`);
    res.status(201).json({ success: true, data: reading });
});

// Get latest reading
app.get('/api/live', (req, res) => {
    const { device_id } = req.query;
    
    if (!device_id) {
        return res.status(400).json({ error: 'device_id is required' });
    }
    
    const readings = noiseReadings.filter(r => r.device_id === device_id);
    const latest = readings[readings.length - 1];
    
    if (!latest) {
        return res.status(404).json({ error: 'No readings found' });
    }
    
    res.json(latest);
});

// Get history
app.get('/api/history', (req, res) => {
    const { device_id, preset = '60s' } = req.query;
    
    if (!device_id) {
        return res.status(400).json({ error: 'device_id is required' });
    }
    
    let readings = noiseReadings.filter(r => r.device_id === device_id);
    
    // Filter by time based on preset
    const now = new Date();
    let timeLimit;
    
    switch (preset) {
        case '60s': timeLimit = 60 * 1000; break;
        case '60m': timeLimit = 60 * 60 * 1000; break;
        case '24h': timeLimit = 24 * 60 * 60 * 1000; break;
        default: timeLimit = 60 * 1000;
    }
    
    readings = readings.filter(r => (now - new Date(r.timestamp)) <= timeLimit);
    
    res.json({
        device_id,
        preset,
        count: readings.length,
        data: readings
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: `Route ${req.originalUrl} not found` });
});

// Start server
app.listen(PORT, () => {
    console.log(`
    ╔════════════════════════════════════════╗
    ║   Noise Monitor Backend Server         ║
    ╠════════════════════════════════════════╣
    ║   Port: ${PORT}                          ║
    ║   API: http://localhost:${PORT}/api     ║
    ╚════════════════════════════════════════╝
    `);
});