# Video Playback Web Application

This web application is designed to play video files across multiple devices. One device serves as the content source, while another device plays the content.

## Overview

The purpose of this project is to demonstrate a web-based video playback system where one device acts as the content controller and another device serves as the display screen. For example, one device could select and initiate the playback of a video, while another device displays the video content.

## Features

- **Dual Device Playback:** One device controls the video playback, while another device displays the video content.
- **Remote Control:** The controlling device selects the video content and initiates playback remotely on the display device.
- **Full-Screen Playback:** Video content is displayed in full-screen mode on the playback device.

## How It Works

### Device 1 (Controller)

- **Interface:** Provides an interface for selecting and controlling video playback.
- **Initiation:** Initiates the playback of selected video content.
- **Remote Control:** Sends commands to the display device to start playback.

### Device 2 (Display)

- **Playback:** Receives commands from the controller device to start playback.
- **Display:** Shows the video content in full-screen mode.
- **Audio Output:** Plays the video audio while displaying the content.

## Usage

1. **Controller Device:** Use this device to select the video content and initiate playback.
2. **Display Device:** Use this device to view the video content in full-screen mode.

## Implementation

The web application utilizes a client-server architecture, where one device serves as the server hosting the web application, and multiple devices act as clients accessing the application through a web browser.

## Technologies Used

- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Node.js, Express.js
- **Communication:** Socket.IO for real-time communication between devices

## Setup Instructions

1. Clone the repository to your local machine.
2. Install Node.js and npm if not already installed.
3. Navigate to the project directory in your terminal.
4. Install dependencies using `npm install`.
5. Start the server using `npm start`.
6. Access the application through a web browser on both the controller and display devices.

## Note

- For optimal performance, ensure both devices have a stable internet connection.
- Test the application in various scenarios to ensure seamless video playback across devices.

## Authors

[Light-Danube]
[zzarxy]

## License

This project is licensed under the [MIT License](LICENSE).

