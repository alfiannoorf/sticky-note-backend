// ============================================
// BACKEND STICKY NOTE
// - MongoDB Atlas untuk penyimpanan permanen
// - Hugging Face Inference API untuk STT (Whisper, gratis)
// ============================================

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Multer untuk terima file audio upload (disimpan sementara di memori,
// bukan di disk, karena Render free tier tidak punya storage permanen)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // maks 25MB

// ============================================
// KONEKSI KE MONGODB ATLAS
// ============================================
const MONGODB_URI = process.env.MONGODB_URI;
const HF_TOKEN = process.env.HF_TOKEN; // token Hugging Face, diset di Render Environment

if (!MONGODB_URI) {
  console.error('ERROR: MONGODB_URI belum diset!');
  process.exit(1);
}
if (!HF_TOKEN) {
  console.warn('WARNING: HF_TOKEN belum diset - fitur STT tidak akan berfungsi.');
}

mongoose.connect(MONGODB_URI)
  .then(() => console.log('Berhasil terhubung ke MongoDB Atlas'))
  .catch(err => console.error('Gagal terhubung ke MongoDB:', err));

// ============================================
// SCHEMA: Notes (catatan teks biasa, sudah ada sebelumnya)
// ============================================
const noteSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true },
  text: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
});
const Note = mongoose.model('Note', noteSchema);

// ============================================
// SCHEMA BARU: Recordings (hasil rekaman audio -> transkrip -> summary)
// ============================================
const recordingSchema = new mongoose.Schema({
  deviceId: { type: String, required: true },
  transcript: { type: String, default: '' },
  summary: { type: String, default: '' },
  status: { type: String, default: 'processing' }, // processing | transcribed | summarized | failed
  createdAt: { type: Date, default: Date.now }
});
const Recording = mongoose.model('Recording', recordingSchema);

// ============================================
// ENDPOINT: Cek server hidup
// ============================================
app.get('/', async (req, res) => {
  const totalDevices = await Note.countDocuments();
  res.json({
    status: 'ok',
    message: 'Backend sticky note berjalan!',
    totalDevices,
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// ============================================
// ENDPOINT NOTES (sudah ada sebelumnya, tidak berubah)
// ============================================
app.post('/notes/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const { text } = req.body;

  if (!text) return res.status(400).json({ error: 'Field "text" wajib diisi' });

  try {
    const updated = await Note.findOneAndUpdate(
      { deviceId },
      { text, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: `Catatan untuk device ${deviceId} berhasil disimpan`, updatedAt: updated.updatedAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal simpan ke database' });
  }
});

app.get('/notes/:deviceId', async (req, res) => {
  try {
    const note = await Note.findOne({ deviceId: req.params.deviceId });
    if (!note) return res.json({ text: '', updatedAt: null });
    res.json({ text: note.text, updatedAt: note.updatedAt });
  } catch (err) {
    res.status(500).json({ error: 'Gagal ambil dari database' });
  }
});

// ============================================
// ENDPOINT BARU: Upload audio -> transkrip via Hugging Face Whisper
// POST /recordings/:deviceId
// Body: form-data dengan field "audio" (file .wav)
// ============================================
app.post('/recordings/:deviceId', upload.single('audio'), async (req, res) => {
  const { deviceId } = req.params;

  if (!req.file) {
    return res.status(400).json({ error: 'File audio wajib disertakan (field "audio")' });
  }

  if (!HF_TOKEN) {
    return res.status(500).json({ error: 'HF_TOKEN belum dikonfigurasi di server' });
  }

  try {
    // Buat entry baru di database dengan status "processing"
    const recording = await Recording.create({
      deviceId,
      status: 'processing'
    });

    console.log(`[${deviceId}] Menerima audio (${req.file.size} bytes), mengirim ke Hugging Face...`);

    // Kirim audio mentah (binary) ke Hugging Face Inference API
    // CATATAN: endpoint lama "api-inference.huggingface.co" sudah dipensiunkan,
    // diganti dengan "router.huggingface.co" per kebijakan HF terbaru
    const hfResponse = await axios.post(
      'https://router.huggingface.co/hf-inference/models/openai/whisper-large-v3',
      req.file.buffer,
      {
        headers: {
          'Authorization': `Bearer ${HF_TOKEN}`,
          'Content-Type': 'audio/wav',
          'Accept': 'application/json' // wajib diisi eksplisit, endpoint menolak Accept default axios
        },
        timeout: 60000 // 60 detik, karena model bisa lambat di cold start
      }
    );

    const transcriptText = hfResponse.data.text || '';

    recording.transcript = transcriptText;
    recording.status = 'transcribed';
    await recording.save();

    console.log(`[${deviceId}] Transkrip berhasil: "${transcriptText.substring(0, 60)}..."`);

    res.json({
      success: true,
      recordingId: recording._id,
      transcript: transcriptText
    });

  } catch (err) {
    console.error('Error saat proses STT:', err.response?.data || err.message);

    // Kalau model sedang "loading" (cold start), Hugging Face kasih error khusus ini
    if (err.response?.status === 503) {
      return res.status(503).json({
        error: 'Model sedang dimuat di server Hugging Face, coba lagi dalam beberapa detik',
        retryAfter: err.response.data?.estimated_time || 20
      });
    }

    res.status(500).json({ error: 'Gagal proses transkripsi' });
  }
});

// ============================================
// ENDPOINT: Ambil daftar recording + transkrip untuk device tertentu
// GET /recordings/:deviceId
// ============================================
app.get('/recordings/:deviceId', async (req, res) => {
  try {
    const recordings = await Recording.find({ deviceId: req.params.deviceId })
      .sort({ createdAt: -1 })
      .limit(20);
    res.json(recordings);
  } catch (err) {
    res.status(500).json({ error: 'Gagal ambil daftar recording' });
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
