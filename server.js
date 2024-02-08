const express = require('express');
const { createServer } = require('http');
const fs = require("fs");
const path = require('path');
const multer = require('multer');
const { Server } = require("socket.io");
const cors = require('cors');

const ytdl = require('ytdl-core');

const app = express();
const server = createServer(app);
const io = new Server(server);
const PORT = 3000;

app.use(cors());

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

// Получение YouTube видео и передача на клиент
app.get('/youtube/:videoId', async (req, res) => {
   try {
      const videoId = req.params.videoId;
      const videoURL = `https://www.youtube.com/watch?v=${videoId}`;
      
      // Получение информации о видео
      const info = await ytdl.getInfo(videoURL);

      // Передача потока видео на клиент
      res.header('Content-Disposition', `attachment; filename="${info.videoDetails.title}.mp4"`);
      ytdl(videoURL, {
         format: 'mp4',
      }).pipe(res);
   } catch (err) {
      console.error('Error fetching YouTube video:', err);
      res.status(500).send('Error fetching YouTube video');
   }
});

// Обработчик подключения к каналу playerControls
io.of("/playerControls").on('connection', (socket) => {
   console.log('a user connected to playerControls');

   // Обработчик события "player start"
   socket.on("player start", () => {
      console.log("server socked player started")
      // Отправить событие "play" всем клиентам в канале playerControls
      socket.broadcast.emit("play");
   });

   // Обработчик события "player pause"
   socket.on("player pause", () => {
      // Отправить событие "pause" всем клиентам в канале playerControls
      socket.broadcast.emit("pause");
   });

   //Debug on disconnection
   socket.on("disconnect", () => {
      console.log('A user disconnected from playerControls');
   });

   socket.on("player timeupdate", (time) => {
      socket.broadcast.emit("timeupdate", time);
   })

   socket.on("player volumeupdate", (volume) => {
      socket.broadcast.emit("volumeupdate", volume);
   })
});

server.listen(PORT, () => {
   console.log(`Server is running on http://localhost:${PORT}`);
   console.log(`To run video page, use http://localhost:${PORT}/video`);
});
