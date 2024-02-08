const express = require('express');
const { createServer } = require('node:http');
const fs = require("fs");
const path = require('path');
const multer = require('multer');
const { Server } = require("socket.io");

const app = express();
const server = createServer(app);
const io = new Server(server);
const PORT = 3000;

// Настройка папки для загрузки видео файлов
const storage = multer.diskStorage({
   destination: function (req, file, cb) {
      cb(null, 'uploads/');
   },
   filename: function (req, file, cb) {
      cb(null, file.originalname);
   }
});

const upload = multer({ storage: storage });

// Главная страница для загрузки видео
app.get('/', (req, res) => {
   res.sendFile(path.join(__dirname, 'index.html'));
});

// Страница для проигрывания видео
app.get('/video', (req, res) => {
   res.sendFile(path.join(__dirname, 'video.html'));
});

app.get('/videofile', (req, res) => {
   const range = req.headers.range;
   if (!range) {
      res.status(400).send("Requires Range header");
   }
   const videoPath = "uploads/test.mp4";
   const videoSize = fs.statSync("uploads/test.mp4").size;
   const CHUNK_SIZE = 10 ** 6;
   const start = Number(range.replace(/\D/g, ""));
   const end = Math.min(start + CHUNK_SIZE, videoSize - 1);
   const contentLength = end - start + 1;
   const headers = {
      "Content-Range": `bytes ${start}-${end}/${videoSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": contentLength,
      "Content-Type": "video/mp4",
   };
   res.writeHead(206, headers);
   const videoStream = fs.createReadStream(videoPath, { start, end });
   videoStream.pipe(res);
});

app.post('/upload', upload.single('video'), (req, res) => {
   res.redirect('/player.html?video=' + req.file.filename);
});

// Статическая директория для доступа к загруженным видео файлам
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

io.on('connection', (socket) => {
   console.log('a user connected');
});

server.listen(PORT, () => {
   console.log(`Server is running on http://localhost:${PORT}`);
});
