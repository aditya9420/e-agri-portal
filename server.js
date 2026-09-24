require('dotenv').config();
const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const SECRET = 'eagri_secret_key_123';

// Multer Config
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// --- Auth Middleware ---
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, SECRET);
        req.user = decoded; // { id, role }
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    next();
};

const requireFarmer = (req, res, next) => {
    if (req.user.role !== 'farmer') return res.status(403).json({ error: 'Forbidden' });
    next();
};

// --- Routes ---

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/me', authenticate, (req, res) => {
    const table = req.user.role === 'admin' ? 'Admins' : 'Farmers';
    db.get('SELECT id, name, email, phone, address FROM ' + table + ' WHERE id = ?', [req.user.id], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'Not found' });
        res.json({ ...user, role: req.user.role });
    });
});

app.post('/api/auth/register', async (req, res) => {
    const { name, email, phone, address, password } = req.body;
    try {
        const hashed = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO Farmers (name, email, phone, address, hashed_password) VALUES (?, ?, ?, ?, ?)`,
            [name, email, phone, address, hashed],
            function(err) {
                if (err) return res.status(400).json({ error: 'Registration failed (email may exist)' });
                const token = jwt.sign({ id: this.lastID, role: 'farmer' }, SECRET);
                res.json({ token, role: 'farmer', user: { id: this.lastID, name, email } });
            });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Temporary endpoint to seed the admin account on cloud databases
app.get('/api/seed-admin', async (req, res) => {
    try {
        const hashedPassword = await bcrypt.hash('admin123', 10);
        db.get(`SELECT id FROM Admins WHERE email = $1`, ['admin@eagri.gov'], (err, row) => {
            if (row) return res.json({ message: 'Admin already seeded' });
            
            db.run(`INSERT INTO Admins (name, email, hashed_password) VALUES ($1, $2, $3)`,
                ['Admin', 'admin@eagri.gov', hashedPassword],
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ message: 'Admin seeded successfully!', success: true });
                }
            );
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/auth/login', (req, res) => {
    const { email, password, role } = req.body;
    const table = role === 'admin' ? 'Admins' : 'Farmers';
    db.get(`SELECT * FROM ${table} WHERE email = ?`, [email], async (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });
        const valid = await bcrypt.compare(password, user.hashed_password);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
        const token = jwt.sign({ id: user.id, role }, SECRET);
        res.json({ token, role, user: { id: user.id, name: user.name, email: user.email } });
    });
});

// Farmer: Dashboard Stats
app.get('/api/farmer/stats', authenticate, requireFarmer, (req, res) => {
    db.get(`SELECT 
        (SELECT COUNT(*) FROM Crops WHERE farmer_id = ?) as active_crops,
        (SELECT COUNT(*) FROM DiseaseReports WHERE farmer_id = ?) as total_reports,
        (SELECT COUNT(*) FROM DiseaseReports WHERE farmer_id = ? AND status='Pending') as pending_reports,
        (SELECT COUNT(*) FROM GovtSchemes) as available_schemes
    `, [req.user.id, req.user.id, req.user.id], (err, row) => {
        res.json(row || {});
    });
});

// Farmer: Crops
app.get('/api/crops', authenticate, requireFarmer, (req, res) => {
    db.all(`SELECT * FROM Crops WHERE farmer_id = ? ORDER BY id DESC`, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});
app.post('/api/crops', authenticate, requireFarmer, (req, res) => {
    const { crop_name, sowing_date, harvest_date, fertilizer_details, expenses } = req.body;
    db.run(`INSERT INTO Crops (farmer_id, crop_name, sowing_date, harvest_date, fertilizer_details, expenses) VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.id, crop_name, sowing_date, harvest_date, fertilizer_details, expenses],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID, success: true });
        });
});
app.delete('/api/crops/:id', authenticate, requireFarmer, (req, res) => {
    db.run(`DELETE FROM Crops WHERE id = ? AND farmer_id = ?`, [req.params.id, req.user.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Farmer/Admin: Market Rates
app.get('/api/market', authenticate, (req, res) => {
    db.all(`SELECT * FROM MarketRates ORDER BY price_per_unit DESC`, (err, rows) => res.json(rows || []));
});
app.post('/api/market', authenticate, requireAdmin, (req, res) => {
    const { crop_name, price_per_unit } = req.body;
    const updatedAt = new Date().toISOString();
    db.run(`INSERT INTO MarketRates (crop_name, price_per_unit, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(crop_name) DO UPDATE SET price_per_unit = ?, updated_at = ?`,
        [crop_name, price_per_unit, updatedAt, price_per_unit, updatedAt],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

// Farmer/Admin: Schemes
app.get('/api/schemes', authenticate, (req, res) => {
    db.all(`SELECT * FROM GovtSchemes ORDER BY id DESC`, (err, rows) => res.json(rows || []));
});
app.post('/api/schemes', authenticate, requireAdmin, (req, res) => {
    const { scheme_name, eligibility, benefits, application_link } = req.body;
    db.run(`INSERT INTO GovtSchemes (scheme_name, eligibility, benefits, application_link, created_at) VALUES (?, ?, ?, ?, ?)`,
        [scheme_name, eligibility, benefits, application_link, new Date().toISOString()],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID, success: true });
        });
});
app.delete('/api/schemes/:id', authenticate, requireAdmin, (req, res) => {
    db.run(`DELETE FROM GovtSchemes WHERE id = ?`, [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Farmer: Report Disease
app.post('/api/ai/analyze', authenticate, requireFarmer, upload.single('photo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Photo is required' });
    
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') {
            return res.status(500).json({ error: 'Missing Gemini API Key. Please add it to your .env file.' });
        }

        const ai = new GoogleGenAI({ apiKey });
        
        // Read file to base64
        const fileBytes = fs.readFileSync(req.file.path);
        const base64Image = Buffer.from(fileBytes).toString('base64');
        const mimeType = req.file.mimetype;

        const prompt = `You are an expert plant pathologist. Analyze this plant image. Identify the crop and any disease present.
Provide your response STRICTLY as a raw JSON object without any markdown formatting (no \`\`\`json blocks). Match this exact schema:
{
  "disease": "Name of the disease (or 'Healthy Plant' if none)",
  "confidence": 95,
  "organic": "Suggested organic preventive measures.",
  "chemical": "Suggested chemical measures including exact dosage (e.g. 50ml per 15L of water)."
}`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                prompt,
                { inlineData: { data: base64Image, mimeType: mimeType } }
            ]
        });
        
        let jsonText = response.text;
        // Clean markdown if present
        jsonText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
        const result = JSON.parse(jsonText);
        
        res.json(result);
    } catch (error) {
        console.error('AI Analysis Error:', error);
        res.status(500).json({ error: 'Failed to analyze image with AI. Check server logs.' });
    }
});

app.post('/api/reports', authenticate, requireFarmer, upload.single('photo'), (req, res) => {
    const { crop_id, description } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Photo is required' });
    const imageUrl = '/uploads/' + req.file.filename;
    db.run(`INSERT INTO DiseaseReports (farmer_id, crop_id, image_url, description, report_date) VALUES (?, ?, ?, ?, ?)`,
        [req.user.id, crop_id, imageUrl, description, new Date().toISOString()],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID, success: true });
        });
});
app.get('/api/reports/me', authenticate, requireFarmer, (req, res) => {
    db.all(`SELECT r.*, c.crop_name FROM DiseaseReports r JOIN Crops c ON r.crop_id = c.id WHERE r.farmer_id = ? ORDER BY r.id DESC`, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Admin: Manage Reports
app.get('/api/reports', authenticate, requireAdmin, (req, res) => {
    db.all(`SELECT r.*, c.crop_name, f.name as farmer_name, f.phone FROM DiseaseReports r 
            JOIN Crops c ON r.crop_id = c.id 
            JOIN Farmers f ON r.farmer_id = f.id ORDER BY r.id DESC`, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});
app.put('/api/reports/:id/status', authenticate, requireAdmin, (req, res) => {
    const { status } = req.body;
    db.run(`UPDATE DiseaseReports SET status = ? WHERE id = ?`, [status, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Admin: Farmers
app.get('/api/farmers', authenticate, requireAdmin, (req, res) => {
    db.all(`SELECT id, name, email, phone, address FROM Farmers ORDER BY id DESC`, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});
app.delete('/api/farmers/:id', authenticate, requireAdmin, (req, res) => {
    db.run(`DELETE FROM Farmers WHERE id = ?`, [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Admin: Stats
app.get('/api/stats', authenticate, requireAdmin, (req, res) => {
    db.get(`SELECT 
        (SELECT COUNT(*) FROM Farmers) as total_farmers,
        (SELECT COUNT(*) FROM Crops) as total_crops,
        (SELECT COUNT(*) FROM DiseaseReports) as total_reports,
        (SELECT COUNT(*) FROM DiseaseReports WHERE status='Pending') as pending_reports,
        (SELECT COUNT(*) FROM GovtSchemes) as total_schemes
    `, (err, row) => {
        res.json(row || {});
    });
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend running on port ${PORT}`);
});
