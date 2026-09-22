const { Pool } = require('pg');
require('dotenv').config();

// If DATABASE_URL isn't provided, it will fail gracefully (reminding user to set it)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

const init = async () => {
    try {
        const client = await pool.connect();
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS Farmers (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                phone TEXT,
                hashed_password TEXT NOT NULL,
                address TEXT
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
                expenses REAL
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
            CREATE TABLE IF NOT EXISTS GovtSchemes (
                id SERIAL PRIMARY KEY,
                scheme_name TEXT NOT NULL,
                eligibility TEXT NOT NULL,
                benefits TEXT NOT NULL,
                application_link TEXT,
                created_at TEXT NOT NULL
            );
        `);
        console.log('✅ Connected to PostgreSQL Database.');
        client.release();
    } catch (err) {
        console.error('❌ Database connection failed. Did you set DATABASE_URL in .env?', err.message);
    }
};

init();

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

// SQLite Wrapper for existing server.js code
module.exports = {
    run: async (query, params, callback) => {
        if (typeof params === 'function') {
            callback = params;
            params = [];
        }
        try {
            let pgQuery = convertQuery(query);
            // If it's an insert, return the ID just like SQLite's `this.lastID`
            if (pgQuery.trim().toUpperCase().startsWith('INSERT')) {
                 pgQuery += ' RETURNING id';
            }
            const res = await pool.query(pgQuery, params || []);
            if (callback) {
                const lastID = res.rows.length > 0 ? res.rows[0].id : null;
                callback.call({ lastID: lastID }, null);
            }
        } catch (err) {
            if (callback) callback(err);
        }
    },
    get: async (query, params, callback) => {
        if (typeof params === 'function') {
            callback = params;
            params = [];
        }
        try {
            const res = await pool.query(convertQuery(query), params || []);
            if (callback) callback(null, res.rows[0]);
        } catch (err) {
            if (callback) callback(err, null);
        }
    },
    all: async (query, params, callback) => {
        if (typeof params === 'function') {
            callback = params;
            params = [];
        }
        try {
            const res = await pool.query(convertQuery(query), params || []);
            if (callback) callback(null, res.rows);
        } catch (err) {
            if (callback) callback(err, null);
        }
    }
};
