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

// Serve video files dynamically based on the requested file
app.get('/videofile/:filename', (req, res) => {
   const videoPath = path.join(__dirname, 'uploads', req.params.filename);
   const stat = fs.statSync(videoPath);
   const fileSize = stat.size;
   const range = req.headers.range;

   if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(videoPath, { start, end });
      const head = {
         'Content-Range': `bytes ${start}-${end}/${fileSize}`,
         'Accept-Ranges': 'bytes',
         'Content-Length': chunksize,
         'Content-Type': 'video/mp4',
      };

      res.writeHead(206, head);
      file.pipe(res);
   } else {
      const head = {
         'Content-Length': fileSize,
         'Content-Type': 'video/mp4',
      };

      res.writeHead(200, head);
      fs.createReadStream(videoPath).pipe(res);
   }
});

app.post('/upload', upload.single('video'), (req, res) => {
   console.log("Video uploaded successfully.");
   io.of("/playerControls").emit("file uploaded");
   res.sendStatus(204);
});


// Статическая директория для доступа к загруженным видео файлам
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Получение YouTube видео и передача на клиент
app.get('/youtube/:videoId', async (req, res) => {
   try {
      const videoId = req.params.videoId;
      
      // Проверка, что videoId соответствует ожидаемому формату
      const videoIdRegex = /^[a-zA-Z0-9-_]{11}$/;
      if (!videoIdRegex.test(videoId)) {
         throw new Error('Invalid video ID format');
      }

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

   // Обработчик события "stop"
   socket.on("stop", () => {
      // Отправить событие "stop" всем клиентам в канале playerControls
      socket.broadcast.emit("stop");
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

   // Handle receiving video URL from controller page
   socket.on("video url", (url) => {
      // Broadcast the received URL to all clients (including the puppet page)
      socket.broadcast.emit("video url", url);
   });
});

server.listen(PORT, () => {
   console.log(`Server is running on http://localhost:${PORT}`);
   console.log(`To run video page, use http://localhost:${PORT}/video`);
});
