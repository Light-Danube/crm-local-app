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

1. **Controller Device:** On `/`, choose “Відео з пристрою” or “YouTube”. The controller shows the shared pairing code.
2. **Display Device:** On the viewing device, open the application and choose “Приєднати екран” in the top navigation, then enter that code. The controller also has “Відкрити екран” for opening another screen in a new tab.

## UI prototype

After starting the server, open `/prototypes/references.html` for the saved source patterns and `/prototypes/session-workspace.html` for the interactive controller/display prototype. Its actions use demo data; they do not upload files, connect screens or play YouTube. The working application remains at `/`.

On the prototype, choose a local file or YouTube URL, send it, try playback controls, and add/remove demo screens. Switch to “Екран”, try an incorrect code, then `482619`, and simulate autoplay recovery. Test keyboard navigation and a narrow viewport. Record task completion, mistakes and comments; the automated checks do not replace user testing. See [the research and test scenarios](docs/ui/research-2026-10-20.md).

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

## YouTube playback

Paste a watch, Shorts or youtu.be link on the controller. A link such as `https://www.youtube.com/watch?v=RoYXgdHafBA&list=RDRoYXgdHafBA&start_radio=1` selects that video; radio and playlist parameters do not start a playlist. YouTube plays through its official embedded player on each device. Use the controller's YouTube play/pause buttons, position slider and shared volume/effects controls. Each device needs Internet access; private, unavailable or embedding-disabled videos show a visible error. If autoplay is blocked, click the display's recovery button.

This replaces application playback through the unmaintained `ytdl-core` extractor. Local MP4/WebM files still use native video. YouTube playback and timing follow the embedded player's capabilities; frame synchronization is not guaranteed.

One pairing code connects multiple displays until its displayed expiry (default five minutes, five display slots). Joining does not change or extend the code; the owner can explicitly refresh it.

## Note

- For optimal performance, ensure both devices have a stable internet connection.
- Test the application in various scenarios to ensure seamless video playback across devices.

## Authors

[Light-Danube]
[zzarxy]

## License

This project is licensed under the [MIT License](LICENSE).

