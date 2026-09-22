const db = require('./db');
const bcrypt = require('bcrypt');

const seedData = async () => {
    const adminPassword = await bcrypt.hash('admin123', 10);
    
    db.serialize(() => {
        // Seed Admin
        db.run(`INSERT OR IGNORE INTO Admins (email, name, hashed_password) VALUES (?, ?, ?)`, 
            ['admin@eagri.gov', 'System Admin', adminPassword], (err) => {
                if (err) console.error(err);
                else console.log('Admin seeded: admin@eagri.gov / admin123');
            });

        // Seed Market Rates
        const rates = [
            ['Wheat', 25.50],
            ['Rice', 32.00],
            ['Corn', 18.75],
            ['Soybeans', 45.20],
            ['Cotton', 55.00]
        ];
        rates.forEach(rate => {
            db.run(`INSERT OR IGNORE INTO MarketRates (crop_name, price_per_unit, updated_at) VALUES (?, ?, ?)`,
                [rate[0], rate[1], new Date().toISOString()]);
        });

        // Seed Schemes
        const schemes = [
            ['PM-Kisan', 'All landholding farmers', 'Rs. 6000 per year', 'https://pmkisan.gov.in/'],
            ['Crop Insurance', 'Farmers growing notified crops', 'Financial support in case of crop failure', 'https://pmfby.gov.in/'],
            ['Soil Health Card', 'All farmers', 'Crop-wise recommendations of nutrients and fertilizers', 'https://soilhealth.dac.gov.in/']
        ];
        schemes.forEach(scheme => {
            db.run(`INSERT OR IGNORE INTO GovtSchemes (scheme_name, eligibility, benefits, application_link, created_at) VALUES (?, ?, ?, ?, ?)`,
                [scheme[0], scheme[1], scheme[2], scheme[3], new Date().toISOString()]);
        });
        
        console.log('Seeding finished.');
    });
};

setTimeout(seedData, 1000); // Wait for db init
