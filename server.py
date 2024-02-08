from flask import Flask, request, send_file, redirect, url_for, render_template
from flask_socketio import SocketIO, emit
import os

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
    return render_template('video.html', video=video)

# Endpoint for streaming video files
@app.route('/stream/<path:filename>')
def stream_file(filename):
    return send_file(os.path.join('uploads', filename))

# WebSocket connection handling
@socketio.on('control')
def handle_control(message):
    action = message['action']
    if action == 'play':
        # Logic to play the video
        print("Video is playing...")
        socketio.emit('control', {'action': 'play'}, namespace='/playerControls')
    elif action == 'stop':
        # Logic to stop the video
        print("Video is stopped.")
        socketio.emit('control', {'action': 'stop'}, namespace='/playerControls')

if __name__ == '__main__':
    socketio.run(app, debug=True)

