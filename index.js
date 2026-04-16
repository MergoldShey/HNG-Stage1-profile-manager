const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { v7: uuidv7 } = require('uuid');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 1. DATABASE SETUP
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Initialize Table (Runs once when server starts)
const initDB = async () => {
    const query = `
    CREATE TABLE IF NOT EXISTS profiles (
        id UUID PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        gender VARCHAR(50),
        gender_probability FLOAT,
        sample_size INTEGER,
        age INTEGER,
        age_group VARCHAR(50),
        country_id VARCHAR(10),
        country_probability FLOAT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`;
    await pool.query(query);
};
initDB().catch(err => console.error("DB Init Error:", err));

// 2. MIDDLEWARE
app.use(cors());
app.use(express.json());

// 3. HELPERS
const getAgeGroup = (age) => {
    if (age <= 12) return 'child';
    if (age <= 19) return 'teenager';
    if (age <= 59) return 'adult';
    return 'senior';
};

// 4. ROUTES

// POST /api/profiles
app.post('/api/profiles', async (req, res) => {
    const { name } = req.body;

    if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ status: "error", message: "Missing or empty name" });
    }
    
    const lowerName = name.toLowerCase().trim();

    try {
        const existing = await pool.query('SELECT * FROM profiles WHERE name = $1', [lowerName]);
        if (existing.rows.length > 0) {
            return res.status(200).json({
                status: "success",
                message: "Profile already exists",
                data: existing.rows[0]
            });
        }

        let genderRes, ageRes, natRes;
        try {
            [genderRes, ageRes, natRes] = await Promise.all([
                axios.get(`https://api.genderize.io?name=${lowerName}`),
                axios.get(`https://api.agify.io?name=${lowerName}`),
                axios.get(`https://api.nationalize.io?name=${lowerName}`)
            ]);
        } catch (e) {
            return res.status(502).json({ status: "error", message: "Upstream server failure" });
        }

        if (!genderRes.data.gender || genderRes.data.count === 0) {
            return res.status(502).json({ status: "error", message: "Genderize returned an invalid response" });
        }
        if (ageRes.data.age === null) {
            return res.status(502).json({ status: "error", message: "Agify returned an invalid response" });
        }
        if (!natRes.data.country || natRes.data.country.length === 0) {
            return res.status(502).json({ status: "error", message: "Nationalize returned an invalid response" });
        }

        const topCountry = natRes.data.country.sort((a, b) => b.probability - a.probability)[0];
        
        const insertQuery = `
            INSERT INTO profiles (id, name, gender, gender_probability, sample_size, age, age_group, country_id, country_probability)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`;
        
        const result = await pool.query(insertQuery, [
            uuidv7(), 
            lowerName, 
            genderRes.data.gender, 
            genderRes.data.probability, 
            genderRes.data.count, 
            ageRes.data.age, 
            getAgeGroup(ageRes.data.age), 
            topCountry.country_id, 
            topCountry.probability
        ]);

        res.status(201).json({ status: "success", data: result.rows[0] });

    } catch (error) {
        res.status(500).json({ status: "error", message: "Internal server error" });
    }
});

// GET /api/profiles
app.get('/api/profiles', async (req, res) => {
    try {
        let { gender, country_id, age_group } = req.query;
        let query = 'SELECT * FROM profiles WHERE 1=1';
        let params = [];
        let count = 1;

        if (gender) {
            query += ` AND LOWER(gender) = $${count++}`;
            params.push(gender.toLowerCase());
        }
        if (country_id) {
            query += ` AND LOWER(country_id) = $${count++}`;
            params.push(country_id.toLowerCase());
        }
        if (age_group) {
            query += ` AND LOWER(age_group) = $${count++}`;
            params.push(age_group.toLowerCase());
        }

        const result = await pool.query(query, params);
        res.status(200).json({
            status: "success",
            count: result.rows.length,
            data: result.rows
        });
    } catch (error) {
        res.status(500).json({ status: "error", message: "Internal server error" });
    }
});

// GET /api/profiles/:id
app.get('/api/profiles/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM profiles WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "Profile not found" });
        }
        res.status(200).json({ status: "success", data: result.rows[0] });
    } catch (error) {
        res.status(500).json({ status: "error", message: "Internal server error" });
    }
});

// DELETE /api/profiles/:id
app.delete('/api/profiles/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM profiles WHERE id = $1', [req.params.id]);
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ status: "error", message: "Internal server error" });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});