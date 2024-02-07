from flask import Flask, request, send_file, redirect, url_for
from flask_socketio import SocketIO, emit
import os
import subprocess

app = Flask(__name__)
socketio = SocketIO(app)

# Endpoint for uploading video files
@app.route('/upload', methods=['POST'])
def upload_file():
    if 'video' not in request.files:
        return redirect(request.url)
    file = request.files['video']
    if file.filename == '':
        return redirect(request.url)
    if file:
        filename = file.filename
        file.save(os.path.join('uploads', filename))
        return redirect(url_for('player', video=filename))

# Endpoint for video player
@app.route('/player')
def player():
    video = request.args.get('video', '')
    return f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Video Player</title>
    </head>
    <body>
        <video width="640" height="480" controls>
            <source src="/stream/{video}" type="video/mp4">
            Your browser does not support the video tag.
        </video>
    </body>
    </html>
    """

# Endpoint for streaming video files
@app.route('/stream/<path:filename>')
def stream_file(filename):
    return send_file(os.path.join('uploads', filename))

# WebSocket connection handling
@socketio.on('control')
def handle_control(message):
    action = message['action']
    # Perform action based on control message
    if action == 'play':
        # Logic to play the video
        pass
    elif action == 'pause':
        # Logic to pause the video
        pass

if __name__ == '__main__':
    socketio.run(app, debug=True)
