const express = require('express');
const { createServer } = require('http');
const fs = require("fs");
const path = require('path');
const multer = require('multer');
const { Server } = require("socket.io");
const cors = require('cors');

const ytdl = require('ytdl-core');
const sanitizeFilename = require('sanitize-filename');

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
   destination: './uploads/',
   filename: (req, file, cb) => {
     cb(null, Date.now() + '-' + file.originalname);
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

app.post('/upload', upload.single('video'), async (req, res) => {
   try {
       const masterId = req.query.userID;
       console.log("Received file:", req.file);
       console.log("Emitted event by connection id:", masterId); 
       if (masterId) {
           if (req.file) {
               console.log("Video uploaded successfully.");
               io.to(masterId).emit("file uploaded", { url: req.file.filename });
               res.redirect(`/video.html?video=${req.file.filename}`);
           } else {
               const youtubeUrl = req.body.youtubeUrl;
               if (youtubeUrl) {
                   res.redirect(`/video.html?video=${youtubeUrl}`);
               } else {
                   res.status(400).send('No file or YouTube URL provided');
               }
           }
       } else {
           res.status(404).send('Connection ID not found or invalid');
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

      // Санитизация названия видео для использования в имени файла
      const sanitizedTitle = sanitizeFilename(info.videoDetails.title);

      // Кодирование названия файла для обработки специальных символов
      const encodedFilename = encodeURIComponent(sanitizedTitle);

      // Передача потока видео на клиент
      res.header('Content-Disposition', `attachment; filename="${encodedFilename}.mp4"`);
      ytdl(videoURL, {
         filter: 'audioandvideo',
         format: 'mp4',
      }).pipe(res);
   } catch (err) {
      console.error('Error fetching YouTube video:', err);
      res.status(500).send('Error fetching YouTube video');
   }
});


//Added logging values:
const date = new Date().toLocaleDateString().replace(/\//g, '-');
const logFileName = `connections-${date}.log`;

const logStream = fs.createWriteStream(logFileName, { flags: 'a' });

// Обработчик подключения к каналу playerControls
io.of('/playerControls').on('connection', (socket) => {
   console.log('A user connected to playerControls');

   // **Crucial fix:** Store the socket's user ID (if provided)
   if (socket.handshake.query.userID) {
      userSockets.set(socket.handshake.query.userID, socket);
      socket.connectionSocketID = socket.handshake.query.userID;
   }

   socket.on('connectToMaster', (userID) => {
      // Check if the userID exists in the Map object
      if (userSockets.has(userID)) {
        // Connect the puppet page to the master page
        const masterSocket = userSockets.get(userID);
        masterSocket.puppets = masterSocket.puppets || new Set();
        masterSocket.puppets.add(socket.id);
        socket.connectionSocketID = userID;
        socket.join(userID); // Join the socket to the master's room
        //masterSocket.emit('puppetConnected', socket.id);
        socket.emit('masterConnected', masterSocket.id);
        console.log(masterSocket.puppets)
      } else {
        // If the userID doesn't exist, send an error message
        socket.emit('error', 'No master page found with the provided userID');
      }
   });

   socket.on('disconnect', () => {
      // **Логирование:**
      const date = new Date().toLocaleDateString().replace(/\//g, '-');
      const time = new Date().toLocaleTimeString();
      const logMessage = `** ${date} ${time} - Пользователь ${socket.id} отключился`;
      logStream.write(`${logMessage}\n`);
    
      // **Проверка, является ли сокет мастером:**
      if (userSockets.has(socket.id) && userSockets.get(socket.id).puppets) {
        // **Логирование:**
        logStream.write(`** ${date} ${time} - Удаление марионеток мастера ${socket.id}\n`);
    
        // **Удаление всех марионеток мастера:**
        for (const puppetId of userSockets.get(socket.id).puppets) {
          userSockets.delete(puppetId);
    
          // **Логирование:**
          logStream.write(`** ${date} ${time} - Удаление марионетки ${puppetId}\n`);
        }
    
        // **Удаление мастера из userSockets:**
        userSockets.delete(socket.id);
      }

      // Check if the socket is a master
      if (socket.handshake.query.userID) {
         // Remove the master socket from userSockets
         userSockets.delete(socket.handshake.query.userID);
      }
    
      // **Удаление марионетки из списка мастера:**
      if (socket.connectionSocketID) {
        const masterSocket = userSockets.get(socket.connectionSocketID);
        if (masterSocket && masterSocket.puppets) {
          masterSocket.puppets.delete(socket.id);
    
          // **Логирование:**
          logStream.write(`** ${date} ${time} - Удаление марионетки ${socket.id} из списка мастера ${masterSocket.id}\n`);
        }
      }
    
      // **Логирование:**
      logStream.write(`** ${date} ${time} - Удаление сокета ${socket.id} из userSockets\n`);
   });    


   // Обработчик события "player start"
   socket.on("player start", () => {
      console.log("server socked player started")
      // Отправить событие "play" всем клиентам в канале playerControls
      socket.to(socket.connectionSocketID).emit('play');
   });

   // Обработчик события "player pause"
   socket.on("player pause", () => {
      // Отправить событие "pause" всем клиентам в канале playerControls
      socket.to(socket.connectionSocketID).emit("pause");
   });

   // Обработчик события "stop"
   socket.on("stop", () => {
      // Отправить событие "stop" всем клиентам в канале playerControls
      socket.to(socket.connectionSocketID).emit("stop");
   });

   socket.on("player timeupdate", (time) => {
      socket.to(socket.connectionSocketID).emit("timeupdate", time);
   })

   socket.on("player volumeupdate", (volume) => {
      socket.to(socket.connectionSocketID).emit("volumeupdate", volume);
   })

   // Handle receiving video URL from controller page
   socket.on("video url", (url) => {
      // Broadcast the received URL to all clients (including the puppet page)
      socket.to(socket.connectionSocketID).emit("video url", url);
   });

   // Handle receiving uploaded video URL from master page and emit it to puppet page
   socket.on("video uploaded", (url) => {
      socket.to(socket.connectionSocketID).emit("video uploaded", url);
   });

   //VIDEO PARAMETERS:
   //Inversion:
   socket.on("toggle inversion", () => {
      socket.isVideoInverted = !socket.isVideoInverted;
      socket.to(socket.connectionSocketID).emit("inversion status", socket.isVideoInverted);
   });

   // Handle color optimization button click
   socket.on("optimize color", () => {
      socket.isColorOptimized = !socket.isColorOptimized;
      socket.to(socket.connectionSocketID).emit("color optimization status", socket.isColorOptimized);
   });

   //Handle video "enhancements":
   socket.on("toggle enhance details", (isChecked) => {
      // Emit the enhance details status to all clients (including puppet page)
      socket.to(socket.connectionSocketID).emit("enhance details status", isChecked);
   });
   
     //Handle video "background":
   socket.on("toggle back details", (isChecked) => {
      // Emit the enhance details status to all clients (including puppet page)
      socket.to(socket.connectionSocketID).emit("background optimization status", isChecked);
   });


   // Вывод списка подключений при каждом новом подключении
   logStream.write(`** Текущие подключения (${new Date().toLocaleString()}):\n`);
   for (const [masterId, masterSocket] of userSockets.entries()) {
      logStream.write(`- Мастер: ${masterSocket.id}\n`);
      if (masterSocket.puppets) {
         logStream.write(`  - Марионетки: ${Array.from(masterSocket.puppets)}\n`);
      }
   }
});

// Start the server
server.listen(PORT, () => {
   console.log(`Server is running on http://localhost:${PORT}`);
   console.log(`To upload a video, visit http://localhost:${PORT}/index?type=local or http://localhost:${PORT}/index?type=url`);
});
