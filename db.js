const path = require('path');
const fs = require('fs');
require('dotenv').config();

let usePostgres = false;
let pgPool = null;
let sqliteDb = null;

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

// 1. Initialize SQLite Fallback
const initSqlite = () => {
    const sqlite3 = require('sqlite3').verbose();
    const dbPath = path.join(__dirname, 'eagri.db');
    sqliteDb = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error('❌ Failed to open SQLite database:', err.message);
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
        `, (err) => {});

        sqliteDb.run(`
            CREATE TABLE IF NOT EXISTS Admins (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                hashed_password TEXT NOT NULL
            );
        `, (err) => {});

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
        `, (err) => {});

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
        `, (err) => {});

        sqliteDb.run(`
            CREATE TABLE IF NOT EXISTS MarketRates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                crop_name TEXT UNIQUE NOT NULL,
                price_per_unit REAL NOT NULL,
                updated_at TEXT NOT NULL
            );
        `, (err) => {});

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
        `, (err) => {});

        sqliteDb.run(`
            CREATE TABLE IF NOT EXISTS GovtSchemes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scheme_name TEXT NOT NULL,
                eligibility TEXT NOT NULL,
                benefits TEXT NOT NULL,
                application_link TEXT,
                created_at TEXT NOT NULL
            );
        `, (err) => {});

        sqliteDb.run(`
            CREATE TABLE IF NOT EXISTS ForumPosts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                farmer_id INTEGER NOT NULL REFERENCES Farmers(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
        `, (err) => {});

        sqliteDb.run(`
            CREATE TABLE IF NOT EXISTS ForumComments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                post_id INTEGER NOT NULL REFERENCES ForumPosts(id) ON DELETE CASCADE,
                farmer_id INTEGER NOT NULL REFERENCES Farmers(id) ON DELETE CASCADE,
                comment TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
        `, (err) => {});

        // Safely attempt migrations with callbacks to catch duplicate column errors
        sqliteDb.run("ALTER TABLE Marketplace ADD COLUMN image_url TEXT;", (err) => {});
        sqliteDb.run("ALTER TABLE Marketplace ADD COLUMN category TEXT;", (err) => {});
        sqliteDb.run("ALTER TABLE Marketplace ADD COLUMN location TEXT;", (err) => {});

        // Seed default Admin if empty
        const bcrypt = require('bcrypt');
        sqliteDb.get("SELECT COUNT(*) as count FROM Admins", [], async (err, row) => {
            if (!err && row && row.count === 0) {
                const adminPwd = await bcrypt.hash('admin123', 10);
                sqliteDb.run(
                    "INSERT INTO Admins (name, email, hashed_password) VALUES (?, ?, ?)",
                    ['System Admin', 'admin@eagri.gov', adminPwd],
                    (e) => {}
                );
                console.log('🌱 Seeded default admin: admin@eagri.gov / admin123');
            }
        });

        // Seed default MarketRates if empty
        sqliteDb.get("SELECT COUNT(*) as count FROM MarketRates", [], (err, row) => {
            if (!err && row && row.count === 0) {
                const rates = [
                    ['Wheat', 25.50],
                    ['Rice', 32.00],
                    ['Corn', 18.75],
                    ['Soybeans', 45.20],
                    ['Cotton', 55.00]
                ];
                rates.forEach(rate => {
                    sqliteDb.run(
                        "INSERT INTO MarketRates (crop_name, price_per_unit, updated_at) VALUES (?, ?, ?)",
                        [rate[0], rate[1], new Date().toISOString()],
                        (e) => {}
                    );
                });
                console.log('🌱 Seeded default market rates.');
            }
        });

        // Seed default GovtSchemes if empty
        sqliteDb.get("SELECT COUNT(*) as count FROM GovtSchemes", [], (err, row) => {
            if (!err && row && row.count === 0) {
                const schemes = [
                    ['PM-Kisan Samman Nidhi', 'All landholding farmer families', 'Financial benefit of Rs. 6000 per year in 3 installments', 'https://pmkisan.gov.in/'],
                    ['Pradhan Mantri Fasal Bima Yojana (PMFBY)', 'Farmers growing notified crops in notified areas', 'Comprehensive insurance coverage against crop failure', 'https://pmfby.gov.in/'],
                    ['Soil Health Card Scheme', 'All farmers across India', 'Nutrient status assessment and crop-wise dosage recommendations', 'https://soilhealth.dac.gov.in/']
                ];
                schemes.forEach(scheme => {
                    sqliteDb.run(
                        "INSERT INTO GovtSchemes (scheme_name, eligibility, benefits, application_link, created_at) VALUES (?, ?, ?, ?, ?)",
                        [scheme[0], scheme[1], scheme[2], scheme[3], new Date().toISOString()],
                        (e) => {}
                    );
                });
                console.log('🌱 Seeded default government schemes.');
            }
        });
    });
};

// 2. Try PostgreSQL if DATABASE_URL is valid, otherwise use SQLite
const init = async () => {
    const dbUrl = process.env.DATABASE_URL;
    // If DATABASE_URL is missing or contains the expired Render Postgres hostname, skip Postgres directly
    if (!dbUrl || dbUrl.includes('dpg-dape0me0tbcc73aio1u0-a')) {
        console.log('ℹ️ No active cloud PostgreSQL DATABASE_URL found. Using local SQLite engine.');
        usePostgres = false;
        initSqlite();
        return;
    }

    try {
        const { Pool } = require('pg');
        pgPool = new Pool({
            connectionString: dbUrl,
            ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false },
            connectionTimeoutMillis: 3000
        });

        const client = await pgPool.connect();
        console.log('✅ Connected to Cloud PostgreSQL Database.');
        usePostgres = true;
        client.release();
    } catch (err) {
        console.warn('⚠️ Cloud PostgreSQL connection failed:', err.message);
        console.log('🔄 Gracefully falling back to local SQLite engine (eagri.db)...');
        usePostgres = false;
        initSqlite();
    }
};

init();

// Unified Database API wrapping both PostgreSQL and SQLite
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
        } else {
            if (!sqliteDb) initSqlite();
            sqliteDb.run(query, params, function(err) {
                if (callback) callback.call(this, err);
            });
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
        } else {
            if (!sqliteDb) initSqlite();
            sqliteDb.get(query, params, (err, row) => {
                if (callback) callback(err, row);
            });
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
        } else {
            if (!sqliteDb) initSqlite();
            sqliteDb.all(query, params, (err, rows) => {
                if (callback) callback(err, rows);
            });
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
