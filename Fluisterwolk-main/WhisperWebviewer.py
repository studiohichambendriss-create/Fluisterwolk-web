from flask import Flask, render_template, request, jsonify, send_from_directory
import json
import os
import shutil
import time
import socket
import netifaces as ni
import logging
import psutil
from pynput.keyboard import Controller, Key
import sys
from datetime import datetime

app = Flask(__name__)

# File paths for JSON files and directories

# File paths for JSON files and directories
calibration_file = "calibration.json"
device_settings_file = "device_settings.json"
textandcolors_file = "textandcolors.json"
backup_folder = "backup"
whisperbook_file = "whisperbook.json"
deletesoon_file = "deletesoon.json"
whisper_folder = "whispers"
deletesoon_folder = "deletesoon"


def load_json_data(file_path):
    if os.path.exists(file_path):
        try:
            # Try to load the JSON file
            with open(file_path, 'r') as json_file:
                data = json.load(json_file)
                print(f"Loaded data from {file_path}: {data}")  # Debug: Print the loaded data
                return data
        except json.JSONDecodeError as e:
            # If there is an error, create a backup of the broken JSON file
            backup_path = f"{file_path}_broken_{int(time.time())}.json"
            shutil.copy(file_path, backup_path)
            print(f"Error reading {file_path}: {e}. Created backup at {backup_path}")  # Debug: Print JSON errors
            
            # Create a new valid JSON file
            with open(file_path, 'w') as json_file:
                json.dump([], json_file)
                print(f"Recreated {file_path} with empty data.")
            return []
    else:
        # If file does not exist, create it with empty data
        print(f"File {file_path} does not exist. Creating new file.")
        with open(file_path, 'w') as json_file:
            json.dump([], json_file)
        return []

# Helper function to save JSON content to a file
def save_json_data(file_path, data):
    with open(file_path, 'w') as json_file:
        json.dump(data, json_file, indent=4)

@app.route('/')
def index():
    whisperbook_data = load_json_data(whisperbook_file)
    deletesoon_data = load_json_data(deletesoon_file)

    # Sort whisperbook by timestamp descending (newest first)
    whisperbook_data.sort(key=lambda x: x.get('timestamp', 0), reverse=True)

    return render_template('index.html', 
                         whisperbook=whisperbook_data,
                         deletesoon=deletesoon_data)



@app.route('/settings')
def settings():
    calibration_data = load_json_data(calibration_file)
    device_settings_data = load_json_data(device_settings_file)
    textandcolors_data = load_json_data(textandcolors_file)

    return render_template('settings.html', calibration=calibration_data, 
                           device_settings=device_settings_data, 
                           textandcolors=textandcolors_data)





@app.route('/edit_json', methods=['POST'])
def edit_json():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"status": "error", "message": "Invalid request data"}), 400

        json_type = data.get('json_type')
        key = data.get('key')
        value = data.get('value')

        # Load the appropriate file
        if json_type == 'calibration':
            json_file = calibration_file
        elif json_type == 'device_settings':
            json_file = device_settings_file
        elif json_type == 'textandcolors':
            json_file = textandcolors_file
        else:
            return jsonify({"status": "error", "message": "Invalid JSON type"}), 400

        # Load existing data
        json_data = load_json_data(json_file)

        # Update the value
        json_data[key] = value

        # Save the updated JSON
        save_json_data(json_file, json_data)

        return jsonify({"status": "success", "message": f"Updated {key} in {json_type}"}), 200
    except Exception as e:
        logging.error(f"Exception occurred while processing request: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500




@app.route('/backup', methods=['POST'])
def backup():
    # Ensure backup folder exists
    if not os.path.exists(backup_folder):
        os.makedirs(backup_folder)

    # Copy all JSON files to the backup folder
    shutil.copy(calibration_file, backup_folder)
    shutil.copy(device_settings_file, backup_folder)
    shutil.copy(textandcolors_file, backup_folder)

    return jsonify({"status": "success", "message": "Backup completed"}), 200

@app.route('/restore', methods=['POST'])
def restore():
    # Check if the backup folder exists
    if not os.path.exists(backup_folder):
        return jsonify({"status": "error", "message": "No backup found"}), 404

    # Restore the JSON files from the backup folder
    shutil.copy(os.path.join(backup_folder, "calibration.json"), calibration_file)
    shutil.copy(os.path.join(backup_folder, "device_settings.json"), device_settings_file)
    shutil.copy(os.path.join(backup_folder, "textandcolors.json"), textandcolors_file)

    return jsonify({"status": "success", "message": "Backup restored successfully"}), 200




# Serve the audio files from the 'whispers' folder
@app.route('/whispers/<filename>')
def serve_audio(filename):
    return send_from_directory(whisper_folder, filename)

# Serve the audio files from the 'deletesoon' folder
@app.route('/deletesoon/<filename>')
def serve_deletesoon_audio(filename):
    return send_from_directory(deletesoon_folder, filename)

@app.route('/kill_fluisterbox', methods=['POST'])
def kill_fluisterbox():
    try:
        # Initialize the keyboard controller
        keyboard = Controller()

        # Simulate the Escape key press
        keyboard.press(Key.esc)
        keyboard.release(Key.esc)

        return jsonify({"status": "success", "message": "Simulated Escape key press"}), 200
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500



@app.route('/delete/<filename>', methods=['DELETE'])
def move_to_deletesoon(filename):
    whisperbook_data = load_json_data(whisperbook_file)
    deletesoon_data = load_json_data(deletesoon_file)

    # Find the entry in whisperbook.json
    entry_to_delete = None
    for entry in whisperbook_data:
        if entry['filename'] == filename:
            entry_to_delete = entry
            break

    if entry_to_delete:
        # Remove the entry from whisperbook.json
        whisperbook_data = [entry for entry in whisperbook_data if entry['filename'] != filename]
        save_json_data(whisperbook_file, whisperbook_data)

        # Move the file to deletesoon folder
        src_file_path = os.path.join(whisper_folder, filename)
        dst_file_path = os.path.join(deletesoon_folder, filename)
        if os.path.exists(src_file_path):
            shutil.move(src_file_path, dst_file_path)

            # Add the full entry to deletesoon.json
            deletesoon_data.append(entry_to_delete)
            save_json_data(deletesoon_file, deletesoon_data)
            return jsonify({"status": "success"}), 200
        else:
            return jsonify({"status": "file not found"}), 404
    else:
        return jsonify({"status": "file not found in whisperbook"}), 404

# Permanently delete all files in the 'deletesoon' folder
@app.route('/flush_deletes', methods=['POST'])
def flush_deletes():
    deletesoon_data = load_json_data(deletesoon_file)

    # Delete files in deletesoon folder
    for entry in deletesoon_data:
        file_path = os.path.join(deletesoon_folder, entry['filename'])
        if os.path.exists(file_path):
            os.remove(file_path)

    # Clear deletesoon.json
    save_json_data(deletesoon_file, [])
    return jsonify({"status": "flushed"}), 200

@app.route('/save_all_settings', methods=['POST'])
def save_all_settings():
    # Collect data from all JSON files into one big dictionary
    all_data = {
        "calibration": load_json_data(calibration_file),
        "device_settings": load_json_data(device_settings_file),
        "textandcolors": load_json_data(textandcolors_file)
    }
    save_json_data("saved_configuration.json", all_data)
    return jsonify({"status": "success"}), 200

@app.route('/load_all_settings', methods=['POST'])
def load_all_settings():
    # Load data from the saved configuration
    backup_data = load_json_data("saved_configuration.json")
    if not backup_data:
        return jsonify({"status": "error", "message": "No backup configuration found"}), 404

    # Save each section back to their respective files
    save_json_data(calibration_file, backup_data.get("calibration", {}))
    save_json_data(device_settings_file, backup_data.get("device_settings", {}))
    save_json_data(textandcolors_file, backup_data.get("textandcolors", {}))
    return jsonify({"status": "success"}), 200

@app.route('/undo_delete', methods=['POST'])
def undo_last_delete():
    deletesoon_data = load_json_data(deletesoon_file)
    if not deletesoon_data:
        return jsonify({"status": "nothing to undo"}), 400

    # Get the last deleted file (full entry)
    last_entry = deletesoon_data.pop()

    # Move the file back from deletesoon to whispers
    src_file_path = os.path.join(deletesoon_folder, last_entry['filename'])
    dst_file_path = os.path.join(whisper_folder, last_entry['filename'])
    if os.path.exists(src_file_path):
        shutil.move(src_file_path, dst_file_path)

        # Restore the entry in whisperbook.json
        whisperbook_data = load_json_data(whisperbook_file)
        whisperbook_data.append(last_entry)  # Restore the full entry (including confidence, transcription, etc.)
        save_json_data(whisperbook_file, whisperbook_data)

    # Save updated deletesoon.json
    save_json_data(deletesoon_file, deletesoon_data)
    return jsonify({"status": "undo successful"}), 200

def get_local_ip():
    for interface in ni.interfaces():
        try:
            # Get the IP address information for this interface
            iface_addresses = ni.ifaddresses(interface)
            if ni.AF_INET in iface_addresses:
                for link in iface_addresses[ni.AF_INET]:
                    ip = link['addr']
                    # Check if it's in the private IP range
                    if ip.startswith("192.") or ip.startswith("10.") or ip.startswith("172."):
                        return ip
        except ValueError:
            # If any interface info fails, continue to the next
            continue
    
    # Fallback to localhost if no private IP is found
    logging.warning("No valid local IP found. Falling back to 127.0.0.1.")
    return "127.0.0.1"
    

@app.template_filter('datetimeformat')
def datetimeformat_filter(value, format='%Y-%m-%d %H:%M:%S'):
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value).strftime(format)
    elif isinstance(value, str):
        return value  # or handle string dates if needed
    return value

if __name__ == '__main__':
    # Ensure the deletesoon folder exists
    if not os.path.exists(deletesoon_folder):
        os.makedirs(deletesoon_folder)
    logging.basicConfig(level=logging.DEBUG)
    local_ip = get_local_ip()
    print(f"Running on http://{local_ip}:5000")
    app.run(host=local_ip, port=5000, debug=False)
