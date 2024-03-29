const express = require('express');
const { createServer } = require('http');
const fs = require("fs");
const path = require('path');
const multer = require('multer');
const { Server } = require("socket.io");
const cors = require('cors');

const ytdl = require('ytdl-core');
const sanitizeFilename = require('sanitize-filename');

const { setTimeout } = require('timers/promises');

const app = express();
const server = createServer(app);
const io = new Server(server);
const PORT = 3000;

const userSockets = new Map();

app.use(cors());

// Настройка папки для загрузки видео файлов
const storage = multer.diskStorage({
   destination: './uploads/',
   filename: (req, file, cb) => {
     cb(null, file.originalname);
   }
 });

const upload = multer({ storage: storage });

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

// Страница для проигрывания видео
app.get('/video', (req, res) => {
   res.sendFile(path.join(__dirname, 'video.html'));
});

// Store video IDs associated with masterPageIDs
const videoIds = {};

// Handle video requests from puppet page
app.get("/video/:videoId", (req, res) => {
   const { videoId } = req.params;
   // Check if videoId exists and serve the corresponding video file
   if (videoIds.hasOwnProperty(videoId)) {
     const videoPath = `./uploads/${videoIds[videoId]}`;
     res.sendFile(videoPath, { root: __dirname });
   } else {
     res.status(404).send("Video not found");
   }
});

// Serve video files dynamically based on the requested file
app.get('/videofile/:filename', (req, res) => {
   const videoPath = path.join(__dirname, 'uploads', req.params.filename);
 
   try {
     const stat = fs.statSync(videoPath);
     const fileSize = stat.size;
 
     const range = req.headers.range;
 
     if (range) {
       const parts = range.replace(/bytes=/, "").split("-");
       const start = parseInt(parts[0], 10);
       const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
 
       if (start >= fileSize || end >= fileSize || start > end) {
         throw new Error('Invalid byte range');
       }
 
       const chunksize = (end - start) + 1;
       const file = fs.createReadStream(videoPath, { start, end });
 
       const head = {
         'Content-Range': `bytes ${start}-${end}/${fileSize}`,
         'Accept-Ranges': 'bytes',
         'Content-Length': chunksize,
         'Content-Type': 'video/mp4',
         'Content-Disposition': 'attachment' // Optional: Encourage download
       };
 
       res.writeHead(206, head);
       file.pipe(res);
     } else {
       const head = {
         'Content-Length': fileSize,
         'Content-Type': 'video/mp4',
         'Content-Disposition': 'attachment' // Optional: Encourage download
       };
 
       res.writeHead(200, head);
       fs.createReadStream(videoPath).pipe(res);
     }
   } catch (error) {
     console.error('Error serving video file:', error);
     res.status(400).send('Error serving video file'); // Handle errors gracefully
   }
});

app.post('/upload', upload.single('video'), (req, res) => {
   try {
       const masterId = req.query.userID;
       console.log("Received file:", req.file);
       console.log("Emitted event by connection id:", masterId); 
       if (masterId) {
           if (req.file) {
               console.log("Video loaded successfully to server.", req.file.filename);
               //const videoURL = 'http://crm.ucreate.org.ua/uploads${req.file.filename}';
               
               //io.to(masterId).emit("file uploaded", { url: req.file.filename });
               //res.redirect(`/video.html?video=${req.file.filename}`);
               //io.to(masterId).emit("file uploaded", { url: videoURL })
               io.to(masterId).emit("file uploaded", { videoId: req.file.filename });
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
      // Extract video ID from different URL formats
      let videoId = req.params.videoId;

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


//LOGGING:
// Centralized logging configuration
const logDirectory = path.join(__dirname, 'logs'); // Create a "logs" directory if it doesn't exist
const logFileName = `connections-${new Date().toISOString().slice(0, 10)}.log`;
const logFilePath = path.join(logDirectory, logFileName);

const logStream = fs.createWriteStream(logFilePath, { flags: 'a' }); // Open log file in append mode

// Function to write a log message
async function log(message) {
  await logStream.write(`${message}\n`);
}

// Function to log current connections
async function logCurrentConnections() {
  const formattedDate = new Date().toLocaleString();
  await log(`** Current Connections (${formattedDate}):\n`);

  for (const [masterId, masterSocket] of userSockets.entries()) {
    await log(`- Master: ${masterSocket.id}\n`);
    if (masterSocket.puppets) {
      await log(`  - Puppet: ${Array.from(masterSocket.puppets)}\n`);
    }
  }
}

// Обработчик подключения к каналу playerControls
io.of('/playerControls').on('connection', (socket) => {
   console.log('A user connected to playerControls');

   // **Crucial fix:** Store the socket's user ID (if provided)
   if (socket.handshake.query.userID) {
      userSockets.set(socket.handshake.query.userID, socket);
      socket.connectionSocketID = socket.handshake.query.userID;
   }

   // **Immediate connection log using Promise:**
   log(`** ${new Date().toLocaleString()} - User ${socket.id} connected`)
   .catch((error) => {
      // Handle any logging errors gracefully
      console.error('Error logging connection:', error);
   });

   socket.on('connectToMaster', async (userID) => {
      // Check if the userID exists in the Map object
      if (userSockets.has(userID)) {
        // Connect the puppet page to the master page
        const masterSocket = userSockets.get(userID);
        masterSocket.puppets = masterSocket.puppets || new Set();

        // Check if the master already has 2 puppets
        if (masterSocket.puppets && masterSocket.puppets.size >= 1) {
         socket.emit('error', 'Master page already has the maximum number of puppets (1)');
         return;
        }

        masterSocket.puppets.add(socket.id);
        socket.connectionSocketID = userID;
        socket.join(userID); // Join the socket to the master's room

        // **Immediate log for becoming puppet:**
        await log(`** ${new Date().toLocaleString()} - User ${socket.id} became puppet of master ${userID}`);

        socket.emit('masterConnected', masterSocket.id);
        console.log(masterSocket.puppets);
        // Emit an event to the master page with the updated puppet count
        masterSocket.emit('updatePuppets', Array.from(masterSocket.puppets || []).join(', '));
      } else {
        // If the userID doesn't exist, send an error message
        socket.emit('error', 'No master page found with the provided userID');
      }
   });

   socket.on('disconnect', async () => {
      // **Логирование:**
      const date = new Date().toLocaleDateString().replace(/\//g, '-');
      const time = new Date().toLocaleTimeString();
    
      // **Проверка, является ли сокет мастером:**
      if (userSockets.has(socket.id) && userSockets.get(socket.id).puppets) {
        // **Логирование:**
        await log(`** ${date} ${time} - Killing puppets of master ${socket.id}\n`);
    
        // **Удаление всех марионеток мастера:**
        for (const puppetId of userSockets.get(socket.id).puppets) {
          userSockets.delete(puppetId);
    
          // **Логирование:**
          await log(`** ${date} ${time} - Killing puppet ${puppetId}\n`);
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
          await log(`** ${date} ${time} - Killing puppet ${socket.id} from master list ${masterSocket.id}\n`);
        }
      }
    
      // **Логирование:**
      await log(`** ${date} ${time} - Killing page socket ${socket.id} from userSockets\n`);
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
   socket.on("video uploaded", ({ videoId, masterPageID }) => {
      // Emit event to the puppet page with the unique identifier
      socket.to(socket.connectionSocketID).emit("file uploaded", { videoId });
  });

   //VIDEO PARAMETERS:
   //Loop:
   socket.on("toggle loop", () => {
      socket.isVideoLoop = !socket.isVideoLoop;
      socket.to(socket.connectionSocketID).emit("loop status", socket.isVideoLoop);
   });
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
});

// Initialize periodic logging
async function startPeriodicLogging() {
  await logCurrentConnections(); // Log connections initially

  setInterval(async () => {
    await logCurrentConnections();
  }, 60 * 1000); // Log connections every minute
}

// Start the server
// Server startup message
log(`** ${new Date().toLocaleString()} - Server started`);

server.listen(PORT, () => {
   console.log(`Server is running on http://localhost:${PORT}`);
   console.log(`To upload a video, visit http://localhost:${PORT}/index?type=local or http://localhost:${PORT}/index?type=url`);
});

// Server shutdown handler
process.on('SIGINT', async () => {
   console.log('Server shutting down...');
 
   // Log server shutdown message
   await log(`** ${new Date().toLocaleString()} - Server shutting down`);
 
   // Disconnect all sockets
   for (const [socketID, socket] of userSockets.entries()) {
     io.emit("disconnect")
   }
 
   // Clear userSockets map
   userSockets.clear();
 
   // Exit the process (you may want to perform additional cleanup before exiting)
   process.exit(0);
});

//START PERIODIC LOG:
startPeriodicLogging();