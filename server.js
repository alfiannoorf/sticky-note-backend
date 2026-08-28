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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // API key Google Gemini, diset di Render Environment

if (!MONGODB_URI) {
  console.error('ERROR: MONGODB_URI belum diset!');
  process.exit(1);
}
if (!HF_TOKEN) {
  console.warn('WARNING: HF_TOKEN belum diset - fitur STT tidak akan berfungsi.');
}
if (!GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY belum diset - fitur Summary tidak akan berfungsi.');
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
  synced: { type: Boolean, default: false }, // apakah sudah pernah diambil device
  createdAt: { type: Date, default: Date.now }
});
const Recording = mongoose.model('Recording', recordingSchema);

// ============================================
// SCHEMA BARU: Habit Tracker
// ============================================
const habitSchema = new mongoose.Schema({
  deviceId: { type: String, required: true },
  name: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const Habit = mongoose.model('Habit', habitSchema);

// 1 dokumen per hari, isi semua centangan habit hari itu
const dailyHabitLogSchema = new mongoose.Schema({
  deviceId: { type: String, required: true },
  date: { type: String, required: true }, // format "2026-08-15"
  completions: { type: Map, of: Boolean, default: {} } // { habitId: true/false }
});
// Kombinasi deviceId+date harus unik, supaya tidak ada 2 dokumen untuk hari yang sama
dailyHabitLogSchema.index({ deviceId: 1, date: 1 }, { unique: true });
const DailyHabitLog = mongoose.model('DailyHabitLog', dailyHabitLogSchema);

// ============================================
// FUNGSI REUSABLE: Generate summary dari transkrip
// Dipanggil otomatis setelah STT selesai, ATAU manual lewat endpoint /summarize
// ============================================
async function generateSummary(recording) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY belum dikonfigurasi di server');
  }

  const prompt = `Ringkas transkrip meeting/catatan berikut ini dalam bahasa Indonesia,
maksimal 3-4 kalimat, fokus pada poin-poin penting saja:

"${recording.transcript}"`;

  const geminiResponse = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{
        parts: [{ text: prompt }]
      }]
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    }
  );

  const summaryText = geminiResponse.data.candidates[0].content.parts[0].text;

  recording.summary = summaryText;
  recording.status = 'summarized';
  await recording.save();

  return summaryText;
}

// ============================================
// ENDPOINT HABIT TRACKER: Kelola daftar habit
// ============================================

// GET /habits/:deviceId - ambil semua habit milik device
app.get('/habits/:deviceId', async (req, res) => {
  try {
    const habits = await Habit.find({ deviceId: req.params.deviceId }).sort({ createdAt: 1 });
    res.json(habits);
  } catch (err) {
    res.status(500).json({ error: 'Gagal ambil daftar habit' });
  }
});

// POST /habits/:deviceId - tambah habit baru
// Body: { "name": "Olahraga" }
app.post('/habits/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Field "name" wajib diisi' });
  }

  try {
    // Cek dulu apakah habit dengan nama sama sudah ada untuk device ini,
    // supaya tidak numpuk duplikat kalau request tidak sengaja terkirim 2x
    const existing = await Habit.findOne({ deviceId, name: name.trim() });
    if (existing) {
      return res.status(409).json({ error: `Habit "${name.trim()}" sudah ada`, habit: existing });
    }

    const habit = await Habit.create({ deviceId, name: name.trim() });
    res.json({ success: true, habit });
  } catch (err) {
    res.status(500).json({ error: 'Gagal tambah habit' });
  }
});

// DELETE /habits/:habitId - hapus 1 habit
app.delete('/habits/:habitId', async (req, res) => {
  try {
    const deleted = await Habit.findByIdAndDelete(req.params.habitId);
    if (!deleted) {
      return res.status(404).json({ error: 'Habit tidak ditemukan' });
    }
    res.json({ success: true, deletedId: req.params.habitId });
  } catch (err) {
    res.status(500).json({ error: 'Gagal hapus habit' });
  }
});

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

    // ====== OTOMATIS LANJUT KE SUMMARY ======
    // Kalau gagal (misal Gemini lagi "high demand"), status TETAP "transcribed",
    // bukan "failed" - supaya bisa di-retry manual lewat endpoint /summarize
    // tanpa perlu upload ulang audio dari awal
    try {
      const summaryText = await generateSummary(recording);
      console.log(`[${deviceId}] Summary otomatis berhasil: "${summaryText.substring(0, 60)}..."`);

      return res.json({
        success: true,
        recordingId: recording._id,
        transcript: transcriptText,
        summary: summaryText,
        autoSummarized: true
      });
    } catch (summaryErr) {
      console.warn(`[${deviceId}] Transkrip berhasil, tapi auto-summary gagal:`, summaryErr.response?.data || summaryErr.message);

      // Transkrip tetap dianggap sukses meski summary gagal -
      // bisa di-retry manual nanti lewat POST /recordings/:id/summarize
      return res.json({
        success: true,
        recordingId: recording._id,
        transcript: transcriptText,
        summary: null,
        autoSummarized: false,
        note: 'Transkrip berhasil, tapi summary gagal dibuat otomatis. Coba manual lewat endpoint /summarize.'
      });
    }

  } catch (err) {
    console.error('Error saat proses STT:', err.response?.data || err.message);

    // Update status jadi "failed" supaya tidak nyangkut selamanya sebagai "processing"
    await Recording.findOneAndUpdate(
      { deviceId, status: 'processing' },
      { status: 'failed' },
      { sort: { createdAt: -1 } }
    );

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
// ENDPOINT SYNC: Ambil semua data baru untuk device (notes + recording)
// GET /sync/:deviceId
// Cuma kirim recording yang BELUM pernah disync (synced: false)
// supaya device tidak download ulang data yang sama
// ============================================
app.get('/sync/:deviceId', async (req, res) => {
  const { deviceId } = req.params;

  try {
    const note = await Note.findOne({ deviceId });

    const unsyncedRecordings = await Recording.find({
      deviceId,
      status: 'summarized',
      synced: { $ne: true } // cocokkan false ATAU field yang belum ada sama sekali
    }).sort({ createdAt: 1 }); // urut dari yang paling lama, supaya kronologis

    res.json({
      notes: {
        text: note?.text || '',
        updatedAt: note?.updatedAt || null
      },
      recordings: unsyncedRecordings.map(r => ({
        recordingId: r._id,
        transcript: r.transcript,
        summary: r.summary,
        createdAt: r.createdAt
      }))
    });
  } catch (err) {
    console.error('Error saat sync:', err);
    res.status(500).json({ error: 'Gagal proses sync' });
  }
});

// ============================================
// ENDPOINT ACK: Device konfirmasi sudah berhasil simpan data ke SD card
// POST /sync/:deviceId/ack
// Body: { "recordingIds": ["id1", "id2", ...] }
// ============================================
app.post('/sync/:deviceId/ack', async (req, res) => {
  const { deviceId } = req.params;
  const { recordingIds } = req.body;

  if (!Array.isArray(recordingIds)) {
    return res.status(400).json({ error: 'Field "recordingIds" harus berupa array' });
  }

  try {
    const result = await Recording.updateMany(
      { _id: { $in: recordingIds }, deviceId },
      { synced: true }
    );

    console.log(`[${deviceId}] ${result.modifiedCount} recording ditandai sudah disync`);

    res.json({
      success: true,
      updatedCount: result.modifiedCount
    });
  } catch (err) {
    console.error('Error saat ack sync:', err);
    res.status(500).json({ error: 'Gagal update status sync' });
  }
});

// ============================================
// ENDPOINT DEBUG: Lihat SEMUA recording (termasuk yang sudah disync)
// GET /recordings/:deviceId
// Berguna untuk debugging manual lewat Postman, device tidak pakai endpoint ini
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
// ENDPOINT BARU: Buat summary dari transkrip yang sudah ada
// POST /recordings/:recordingId/summarize
// Tidak perlu body apapun - transkrip sudah ada di database,
// tinggal ambil lalu kirim ke Gemini API
// ============================================
app.post('/recordings/:recordingId/summarize', async (req, res) => {
  const { recordingId } = req.params;

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY belum dikonfigurasi di server' });
  }

  try {
    const recording = await Recording.findById(recordingId);

    if (!recording) {
      return res.status(404).json({ error: 'Recording tidak ditemukan' });
    }

    if (!recording.transcript) {
      return res.status(400).json({ error: 'Recording ini belum punya transkrip, tidak bisa dibuat summary' });
    }

    console.log(`Membuat summary untuk recording ${recordingId}...`);

    const summaryText = await generateSummary(recording);

    console.log(`Summary berhasil dibuat: "${summaryText.substring(0, 60)}..."`);

    res.json({
      success: true,
      recordingId: recording._id,
      summary: summaryText
    });

  } catch (err) {
    console.error('Error saat proses summary:', err.response?.data || err.message);
    res.status(500).json({ error: 'Gagal proses summary' });
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
