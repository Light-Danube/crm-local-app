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

const userSockets = new Map();

app.use(cors());

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Redirect users to the /index route when they access the root URL
app.get('/', (req, res) => {
   res.sendFile(path.join(__dirname, 'index.html'));
});

// Handle the selection made by the user and redirect to the appropriate page
app.get('/select', (req, res) => {
   const uploadType = req.query.type;

   if (uploadType === 'local' || uploadType === 'url') {
       // Redirect to the master.html page with the appropriate upload type
       res.redirect(`/master.html?type=${uploadType}`);
   } else {
       // Redirect to the master.html page with the default upload type (local)
       res.redirect('/master.html?type=local');
   }
});

// Serve the master.html file
app.get('/master.html', (req, res) => {
   // Send the master.html file
   res.sendFile(path.join(__dirname, 'master.html'));
});

// Serve the video.html file with query parameters
app.get('/video.html', (req, res) => {
   // Extract the video parameter from the query string
   const videoParam = req.query.video;
   if (videoParam) {
       // If a video parameter is provided, render the video.html file with that parameter
       res.sendFile(path.join(__dirname, 'video.html'));
   } else {
       // If no video parameter is provided, send a 400 Bad Request response
       res.status(400).send('No video parameter provided');
   }
});

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

app.post('/upload', upload.single('video'),  async (req, res) => {
   try {
      if (req.file) {
         // If a file is uploaded, emit "file uploaded" event to all clients
         console.log("Video uploaded successfully.");
         // Emit "file uploaded" event after the redirect
         io.of("/playerControls").emit("file uploaded");
         // Redirect to player.html with the uploaded file
         res.redirect(`/video.html?video=${req.file.filename}`);
      } else {
         // If no file is uploaded, check for YouTube URL
         const youtubeUrl = req.body.youtubeUrl;
         if (youtubeUrl) {
            // Redirect to video.html with YouTube URL as parameter
            res.redirect(`/video.html?video=${youtubeUrl}`);
         } else {
            // Handle the case where neither file nor YouTube URL is provided
            res.status(400).send('No file or YouTube URL provided');
         }
      }
   } catch (err) {
      console.error('Error uploading:', err);
      res.status(500).send('Error uploading');
   }
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

let isVideoInverted = false;
let isColorOptimized = false;

// Обработчик подключения к каналу playerControls
io.of('/playerControls').on('connection', (socket) => {
   console.log('A user connected to playerControls');

   // Add the socket to the userSockets map when a master page connects
   if (socket.handshake.query.userID) {
      userSockets.set(socket.handshake.query.userID, socket);
      socket.masterSocketID = socket.handshake.query.userID;
   }

   // Event listener for disconnecting
   socket.on('disconnect', () => {
      console.log('A user disconnected');
      userSockets.delete(socket.handshake.query.userID);
   });

   socket.on('connectToMaster', (userID) => {
      // Check if the userID exists in the Map object
      if (userSockets.has(userID)) {
        // Connect the puppet page to the master page
        const masterSocket = userSockets.get(userID);
        masterSocket.puppets = masterSocket.puppets || new Set();
        masterSocket.puppets.add(socket.id);
        socket.masterSocketID = userID;
        socket.join(userID); // Join the socket to the master's room
        masterSocket.emit('puppetConnected', socket.id);
        socket.emit('masterConnected', masterSocket.id);
        console.log(masterSocket.puppets)
      } else {
        // If the userID doesn't exist, send an error message
        socket.emit('error', 'No master page found with the provided userID');
      }
   });


   // Обработчик события "player start"
   socket.on("player start", () => {
      console.log("server socked player started")
      // Отправить событие "play" всем клиентам в канале playerControls
      socket.to(socket.masterSocketID).emit('play');
   });

   // Обработчик события "player pause"
   socket.on("player pause", () => {
      // Отправить событие "pause" всем клиентам в канале playerControls
      socket.to(socket.masterSocketID).emit("pause");
   });

   // Обработчик события "stop"
   socket.on("stop", () => {
      // Отправить событие "stop" всем клиентам в канале playerControls
      socket.to(socket.masterSocketID).emit("stop");
   });

   socket.on("player timeupdate", (time) => {
      socket.to(socket.masterSocketID).emit("timeupdate", time);
   })

   socket.on("player volumeupdate", (volume) => {
      socket.to(socket.masterSocketID).emit("volumeupdate", volume);
   })

   // Handle receiving video URL from controller page
   socket.on("video url", (url) => {
      // Broadcast the received URL to all clients (including the puppet page)
      socket.to(socket.masterSocketID).emit("video url", url);
   });

   // Handle receiving uploaded video URL from master page and emit it to puppet page
   socket.on("video uploaded", (url) => {
      socket.to(socket.masterSocketID).emit("video uploaded", url);
   });

   //VIDEO PARAMETERS:
   //Inversion:
   socket.on("toggle inversion", () => {
      isVideoInverted = !isVideoInverted;
      socket.broadcast.emit("inversion status", isVideoInverted);
   });

   // Handle color optimization button click
   socket.on("optimize color", () => {
      isColorOptimized = !isColorOptimized;
      socket.broadcast.emit("color optimization status", isColorOptimized);
   });

   //Handle video "enhancements":
   socket.on("toggle enhance details", (isChecked) => {
      // Emit the enhance details status to all clients (including puppet page)
      socket.broadcast.emit("enhance details status", isChecked);
  });

  //Handle video "background":
  socket.on("toggle back details", (isChecked) => {
   // Emit the enhance details status to all clients (including puppet page)
   socket.broadcast.emit("background optimization status", isChecked);
  });

});

// Start the server
server.listen(PORT, () => {
   console.log(`Server is running on http://localhost:${PORT}`);
   console.log(`To upload a video, visit http://localhost:${PORT}/index?type=local or http://localhost:${PORT}/index?type=url`);
});
