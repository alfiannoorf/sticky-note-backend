// ============================================
// BACKEND DENGAN DATABASE PERMANEN (MongoDB Atlas)
// Data tidak akan hilang lagi meski server restart
// ============================================

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================
// KONEKSI KE MONGODB ATLAS
// URI diambil dari environment variable, BUKAN hardcode di sini
// ============================================
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('ERROR: MONGODB_URI belum diset di environment variable!');
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(() => console.log('Berhasil terhubung ke MongoDB Atlas'))
  .catch(err => console.error('Gagal terhubung ke MongoDB:', err));

// ============================================
// SCHEMA - struktur data yang tersimpan di MongoDB
// Ini pengganti dari objek JavaScript biasa (notesDatabase = {})
// ============================================
const noteSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true },
  text: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
});

const Note = mongoose.model('Note', noteSchema);

// ============================================
// ENDPOINT 1: Cek server hidup
// ============================================
app.get('/', async (req, res) => {
  const totalDevices = await Note.countDocuments();
  res.json({
    status: 'ok',
    message: 'Backend sticky note berjalan!',
    totalDevices: totalDevices,
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// ============================================
// ENDPOINT 2: Web app kirim catatan
// POST /notes/:deviceId
// ============================================
app.post('/notes/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;
  const text = req.body.text;

  if (!text) {
    return res.status(400).json({ error: 'Field "text" wajib diisi' });
  }

  try {
    const updated = await Note.findOneAndUpdate(
      { deviceId: deviceId },
      { text: text, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    console.log(`[${deviceId}] Catatan diupdate:`, text.substring(0, 50) + '...');

    res.json({
      success: true,
      message: `Catatan untuk device ${deviceId} berhasil disimpan`,
      updatedAt: updated.updatedAt
    });
  } catch (err) {
    console.error('Error saat simpan ke database:', err);
    res.status(500).json({ error: 'Gagal simpan ke database' });
  }
});

// ============================================
// ENDPOINT 3: ESP32 ambil catatan
// GET /notes/:deviceId
// ============================================
app.get('/notes/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;

  try {
    const note = await Note.findOne({ deviceId: deviceId });

    if (!note) {
      return res.json({
        text: '',
        updatedAt: null,
        message: 'Belum ada catatan untuk device ini'
      });
    }

    res.json({
      text: note.text,
      updatedAt: note.updatedAt
    });
  } catch (err) {
    console.error('Error saat ambil dari database:', err);
    res.status(500).json({ error: 'Gagal ambil dari database' });
  }
});

// ============================================
// ENDPOINT 4: Lihat semua device (debug)
// ============================================
app.get('/devices', async (req, res) => {
  try {
    const notes = await Note.find({}, 'deviceId updatedAt text');
    const deviceList = notes.map(n => ({
      deviceId: n.deviceId,
      updatedAt: n.updatedAt,
      preview: n.text.substring(0, 30)
    }));
    res.json(deviceList);
  } catch (err) {
    res.status(500).json({ error: 'Gagal ambil daftar device' });
  }
});

// ============================================
// JALANKAN SERVER
// ============================================
app.listen(PORT, () => {
  console.log('========================================');
  console.log(`Server berjalan di port ${PORT}`);
  console.log('========================================');
});
