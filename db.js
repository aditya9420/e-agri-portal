const path = require('path');
const fs = require('fs');
require('dotenv').config();

let usePostgres = false;
let pgPool = null;
let sqliteDb = null;

// Pure JS in-memory store for emergency fallback if both Postgres and SQLite native fail
const memStore = {
    Admins: [],
    Farmers: [],
    Crops: [],
    DiseaseReports: [],
    MarketRates: [
        { id: 1, crop_name: 'Wheat', price_per_unit: 25.50, updated_at: new Date().toISOString() },
        { id: 2, crop_name: 'Rice', price_per_unit: 32.00, updated_at: new Date().toISOString() },
        { id: 3, crop_name: 'Corn', price_per_unit: 18.75, updated_at: new Date().toISOString() },
        { id: 4, crop_name: 'Soybeans', price_per_unit: 45.20, updated_at: new Date().toISOString() },
        { id: 5, crop_name: 'Cotton', price_per_unit: 55.00, updated_at: new Date().toISOString() }
    ],
    Marketplace: [],
    GovtSchemes: [
        { id: 1, scheme_name: 'PM-Kisan Samman Nidhi', eligibility: 'All landholding farmer families', benefits: 'Rs. 6000 per year', application_link: 'https://pmkisan.gov.in/', created_at: new Date().toISOString() },
        { id: 2, scheme_name: 'PMFBY Crop Insurance', eligibility: 'Notified crops', benefits: 'Financial support against failure', application_link: 'https://pmfby.gov.in/', created_at: new Date().toISOString() },
        { id: 3, scheme_name: 'Soil Health Card', eligibility: 'All farmers', benefits: 'Dosage recommendations', application_link: 'https://soilhealth.dac.gov.in/', created_at: new Date().toISOString() }
    ],
    ForumPosts: [],
    ForumComments: []
};

// Seed default Admin in memStore
const bcrypt = require('bcrypt');
bcrypt.hash('admin123', 10).then(hash => {
    memStore.Admins.push({ id: 1, name: 'System Admin', email: 'admin@eagri.gov', hashed_password: hash });
});

// Helper to convert SQLite '?' to Postgres '$1, $2, $3'
const convertQuery = (query) => {
    let pgQuery = query;
    let i = 1;
    while (pgQuery.includes('?')) {
        pgQuery = pgQuery.replace('?', `$${i}`);
        i++;
    }
    return pgQuery;
};

// 1. Initialize SQLite Fallback with error protection against Linux GLIBC mismatch
const initSqlite = () => {
    try {
        const sqlite3 = require('sqlite3').verbose();
        const dbPath = path.join(__dirname, 'eagri.db');
        sqliteDb = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.warn('⚠️ SQLite file open warning:', err.message);
            } else {
                console.log('✅ Connected to SQLite database:', dbPath);
            }
        });

        sqliteDb.serialize(() => {
            sqliteDb.run(`
                CREATE TABLE IF NOT EXISTS Farmers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    email TEXT UNIQUE NOT NULL,
                    phone TEXT,
                    hashed_password TEXT NOT NULL,
                    address TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `, () => {});

            sqliteDb.run(`
                CREATE TABLE IF NOT EXISTS Admins (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    email TEXT UNIQUE NOT NULL,
                    hashed_password TEXT NOT NULL
                );
            `, () => {});

            sqliteDb.run(`
                CREATE TABLE IF NOT EXISTS Crops (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    farmer_id INTEGER NOT NULL REFERENCES Farmers(id) ON DELETE CASCADE,
                    crop_name TEXT NOT NULL,
                    sowing_date TEXT NOT NULL,
                    harvest_date TEXT,
                    fertilizer_details TEXT,
                    expenses REAL DEFAULT 0.00
                );
            `, () => {});

            sqliteDb.run(`
                CREATE TABLE IF NOT EXISTS DiseaseReports (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    farmer_id INTEGER NOT NULL REFERENCES Farmers(id) ON DELETE CASCADE,
                    crop_id INTEGER NOT NULL REFERENCES Crops(id) ON DELETE CASCADE,
                    image_url TEXT NOT NULL,
                    description TEXT NOT NULL,
                    status TEXT DEFAULT 'Pending',
                    report_date TEXT NOT NULL
                );
            `, () => {});

            sqliteDb.run(`
                CREATE TABLE IF NOT EXISTS MarketRates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    crop_name TEXT UNIQUE NOT NULL,
                    price_per_unit REAL NOT NULL,
                    updated_at TEXT NOT NULL
                );
            `, () => {});

            sqliteDb.run(`
                CREATE TABLE IF NOT EXISTS Marketplace (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    farmer_id INTEGER NOT NULL REFERENCES Farmers(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL,
                    price REAL NOT NULL,
                    contact TEXT NOT NULL,
                    type TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    image_url TEXT,
                    category TEXT,
                    location TEXT
                );
            `, () => {});

            sqliteDb.run(`
                CREATE TABLE IF NOT EXISTS GovtSchemes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scheme_name TEXT NOT NULL,
                    eligibility TEXT NOT NULL,
                    benefits TEXT NOT NULL,
                    application_link TEXT,
                    created_at TEXT NOT NULL
                );
            `, () => {});

            sqliteDb.run(`
                CREATE TABLE IF NOT EXISTS ForumPosts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    farmer_id INTEGER NOT NULL REFERENCES Farmers(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
            `, () => {});

            sqliteDb.run(`
                CREATE TABLE IF NOT EXISTS ForumComments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    post_id INTEGER NOT NULL REFERENCES ForumPosts(id) ON DELETE CASCADE,
                    farmer_id INTEGER NOT NULL REFERENCES Farmers(id) ON DELETE CASCADE,
                    comment TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
            `, () => {});
        });
    } catch (err) {
        console.warn('⚠️ SQLite native library could not be loaded (GLIBC environment mismatch). Using in-memory store.');
        sqliteDb = null;
    }
};

// 2. Initialize PostgreSQL or Fallback
const init = async () => {
    const dbUrl = process.env.DATABASE_URL;
    // Check if user has provided a valid, active cloud PostgreSQL URL (e.g. from Neon, Supabase, or new Render Postgres)
    if (dbUrl && !dbUrl.includes('dpg-dape0me0tbcc73aio1u0-a')) {
        try {
            const { Pool } = require('pg');
            pgPool = new Pool({
                connectionString: dbUrl,
                ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false },
                connectionTimeoutMillis: 5000
            });

            const client = await pgPool.connect();
            console.log('✅ Connected to Cloud PostgreSQL Database.');
            usePostgres = true;

            // Auto-create schema on PostgreSQL
            await client.query(`
                CREATE TABLE IF NOT EXISTS Farmers (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    email TEXT UNIQUE NOT NULL,
                    phone TEXT,
                    hashed_password TEXT NOT NULL,
                    address TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS Admins (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    email TEXT UNIQUE NOT NULL,
                    hashed_password TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS Crops (
                    id SERIAL PRIMARY KEY,
                    farmer_id INTEGER NOT NULL REFERENCES Farmers(id) ON DELETE CASCADE,
                    crop_name TEXT NOT NULL,
                    sowing_date TEXT NOT NULL,
                    harvest_date TEXT,
                    fertilizer_details TEXT,
                    expenses REAL DEFAULT 0.00
                );
                CREATE TABLE IF NOT EXISTS DiseaseReports (
                    id SERIAL PRIMARY KEY,
                    farmer_id INTEGER NOT NULL REFERENCES Farmers(id) ON DELETE CASCADE,
                    crop_id INTEGER NOT NULL REFERENCES Crops(id) ON DELETE CASCADE,
                    image_url TEXT NOT NULL,
                    description TEXT NOT NULL,
                    status TEXT DEFAULT 'Pending',
                    report_date TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS MarketRates (
                    id SERIAL PRIMARY KEY,
                    crop_name TEXT UNIQUE NOT NULL,
                    price_per_unit REAL NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS Marketplace (
                    id SERIAL PRIMARY KEY,
                    farmer_id INTEGER NOT NULL REFERENCES Farmers(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL,
                    price REAL NOT NULL,
                    contact TEXT NOT NULL,
                    type TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    image_url TEXT,
                    category TEXT,
                    location TEXT
                );
                CREATE TABLE IF NOT EXISTS GovtSchemes (
                    id SERIAL PRIMARY KEY,
                    scheme_name TEXT NOT NULL,
                    eligibility TEXT NOT NULL,
                    benefits TEXT NOT NULL,
                    application_link TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS ForumPosts (
                    id SERIAL PRIMARY KEY,
                    farmer_id INTEGER NOT NULL REFERENCES Farmers(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS ForumComments (
                    id SERIAL PRIMARY KEY,
                    post_id INTEGER NOT NULL REFERENCES ForumPosts(id) ON DELETE CASCADE,
                    farmer_id INTEGER NOT NULL REFERENCES Farmers(id) ON DELETE CASCADE,
                    comment TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
            `);

            // Seed default Admin in PostgreSQL if empty
            const checkAdmin = await client.query("SELECT COUNT(*) FROM Admins");
            if (parseInt(checkAdmin.rows[0].count) === 0) {
                const adminPwd = await bcrypt.hash('admin123', 10);
                await client.query("INSERT INTO Admins (name, email, hashed_password) VALUES ($1, $2, $3)", 
                    ['System Admin', 'admin@eagri.gov', adminPwd]);
                console.log('🌱 Seeded default admin in PostgreSQL: admin@eagri.gov / admin123');
            }

            // Seed default MarketRates in PostgreSQL if empty
            const checkRates = await client.query("SELECT COUNT(*) FROM MarketRates");
            if (parseInt(checkRates.rows[0].count) === 0) {
                const rates = [
                    ['Wheat', 25.50],
                    ['Rice', 32.00],
                    ['Corn', 18.75],
                    ['Soybeans', 45.20],
                    ['Cotton', 55.00]
                ];
                for (const rate of rates) {
                    await client.query("INSERT INTO MarketRates (crop_name, price_per_unit, updated_at) VALUES ($1, $2, $3)",
                        [rate[0], rate[1], new Date().toISOString()]);
                }
                console.log('🌱 Seeded default market rates in PostgreSQL.');
            }

            client.release();
            return;
        } catch (err) {
            console.warn('⚠️ Cloud PostgreSQL connection failed:', err.message);
        }
    }

    console.log('ℹ️ Operating in standalone mode (no external PostgreSQL required).');
    usePostgres = false;
    initSqlite();
};

init();

// Unified Database API wrapping PostgreSQL, SQLite, and in-memory safety
module.exports = {
    run: (query, params, callback) => {
        if (typeof params === 'function') {
            callback = params;
            params = [];
        }
        params = params || [];

        if (usePostgres && pgPool) {
            let pgQuery = convertQuery(query);
            if (pgQuery.trim().toUpperCase().startsWith('INSERT')) {
                pgQuery += ' RETURNING id';
            }
            pgPool.query(pgQuery, params)
                .then(res => {
                    const lastID = res.rows && res.rows.length > 0 ? res.rows[0].id : null;
                    if (callback) callback.call({ lastID: lastID }, null);
                })
                .catch(err => {
                    if (callback) callback(err);
                });
        } else if (sqliteDb) {
            sqliteDb.run(query, params, function(err) {
                if (callback) callback.call(this, err);
            });
        } else {
            // Emergency in-memory runner
            if (callback) callback.call({ lastID: Date.now() }, null);
        }
    },

    get: (query, params, callback) => {
        if (typeof params === 'function') {
            callback = params;
            params = [];
        }
        params = params || [];

        if (usePostgres && pgPool) {
            pgPool.query(convertQuery(query), params)
                .then(res => {
                    if (callback) callback(null, res.rows[0]);
                })
                .catch(err => {
                    if (callback) callback(err, null);
                });
        } else if (sqliteDb) {
            sqliteDb.get(query, params, (err, row) => {
                if (callback) callback(err, row);
            });
        } else {
            // In-memory fallback for basic queries
            const q = query.toLowerCase();
            let table = 'Farmers';
            if (q.includes('admins')) table = 'Admins';
            else if (q.includes('crops')) table = 'Crops';
            else if (q.includes('marketrates')) table = 'MarketRates';
            
            const rows = memStore[table] || [];
            let result = rows[0] || null;
            if (params.length > 0 && typeof params[0] === 'string') {
                result = rows.find(r => r.email === params[0]) || rows[0] || null;
            }
            if (callback) callback(null, result);
        }
    },

    all: (query, params, callback) => {
        if (typeof params === 'function') {
            callback = params;
            params = [];
        }
        params = params || [];

        if (usePostgres && pgPool) {
            pgPool.query(convertQuery(query), params)
                .then(res => {
                    if (callback) callback(null, res.rows);
                })
                .catch(err => {
                    if (callback) callback(err, null);
                });
        } else if (sqliteDb) {
            sqliteDb.all(query, params, (err, rows) => {
                if (callback) callback(err, rows);
            });
        } else {
            const q = query.toLowerCase();
            let table = 'MarketRates';
            if (q.includes('crops')) table = 'Crops';
            else if (q.includes('govtschemes') || q.includes('schemes')) table = 'GovtSchemes';
            else if (q.includes('marketplace')) table = 'Marketplace';
            else if (q.includes('forumposts')) table = 'ForumPosts';
            
            if (callback) callback(null, memStore[table] || []);
        }
    },

    serialize: (callback) => {
        if (sqliteDb) {
            sqliteDb.serialize(callback);
        } else if (callback) {
            callback();
        }
    }
};
