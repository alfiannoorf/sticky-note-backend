// ============================================
// BACKEND SEDERHANA UNTUK BELAJAR
// Tanpa database dulu, data disimpan di memori (RAM)
// Kalau server restart, data akan hilang - ini normal untuk belajar
// ============================================

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Middleware supaya bisa terima data JSON dan diakses dari device/browser manapun
app.use(cors());
app.use(express.json());

// ============================================
// "DATABASE" SEMENTARA (disimpan di RAM/memori)
// Struktur: { deviceId: [array poin-poin catatan] }
// ============================================
let notesDatabase = {};

// ============================================
// ENDPOINT 1: Cek server hidup atau tidak
// GET http://localhost:3000/
// ============================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Backend sticky note berjalan!',
    totalDevices: Object.keys(notesDatabase).length
  });
});

// ============================================
// ENDPOINT 2: Web app kirim catatan untuk device tertentu
// POST http://localhost:3000/notes/:deviceId
// Body: { "text": "- poin 1\n- poin 2\n- poin 3" }
// ============================================
app.post('/notes/:deviceId', (req, res) => {
  const deviceId = req.params.deviceId;
  const text = req.body.text;

  if (!text) {
    return res.status(400).json({ error: 'Field "text" wajib diisi' });
  }

  // Simpan teks mentah, nanti device yang parsing jadi poin-poin
  notesDatabase[deviceId] = {
    text: text,
    updatedAt: new Date().toISOString()
  };

  console.log(`[${deviceId}] Catatan diupdate:`, text.substring(0, 50) + '...');

  res.json({
    success: true,
    message: `Catatan untuk device ${deviceId} berhasil disimpan`,
    updatedAt: notesDatabase[deviceId].updatedAt
  });
});

// ============================================
// ENDPOINT 3: ESP32 ambil catatan terbaru untuk device-nya
// GET http://localhost:3000/notes/:deviceId
// ============================================
app.get('/notes/:deviceId', (req, res) => {
  const deviceId = req.params.deviceId;
  const data = notesDatabase[deviceId];

  if (!data) {
    return res.json({
      text: '',
      updatedAt: null,
      message: 'Belum ada catatan untuk device ini'
    });
  }

  res.json(data);
});

// ============================================
// ENDPOINT 4: Lihat semua device yang pernah kirim data (untuk debug)
// GET http://localhost:3000/devices
// ============================================
app.get('/devices', (req, res) => {
  const deviceList = Object.keys(notesDatabase).map(id => ({
    deviceId: id,
    updatedAt: notesDatabase[id].updatedAt,
    preview: notesDatabase[id].text.substring(0, 30)
  }));

  res.json(deviceList);
});

// ============================================
// JALANKAN SERVER
// ============================================
app.listen(PORT, () => {
  console.log('========================================');
  console.log(`Server berjalan di http://localhost:${PORT}`);
  console.log('========================================');
  console.log('Endpoint yang tersedia:');
  console.log(`  GET  http://localhost:${PORT}/`);
  console.log(`  POST http://localhost:${PORT}/notes/:deviceId`);
  console.log(`  GET  http://localhost:${PORT}/notes/:deviceId`);
  console.log(`  GET  http://localhost:${PORT}/devices`);
  console.log('========================================');
});
