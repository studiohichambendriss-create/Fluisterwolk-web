import os
import sys
import time
import wave
import pyaudio
import pygame
import random
import json
import numpy as np
from scipy.io import wavfile
from threading import Thread
import librosa
import concurrent.futures
import threading
from whisperai import transcribe_audio  # Import your whisper transcription function
import threading
import whisper
from collections import deque
import time
from serial import Serial, SerialException
import soundfile as sf
import shutil
import serial
import serial.tools.list_ports
import requests

# Debug print function
def debug_print(message):
    """Add a debug message to the list and print to console"""
    print(message)
    debug_messages.append(message)
    if len(debug_messages) > 100:  # Keep only last 100 messages
        debug_messages.pop(0)

# Debug overlay variables
debug_messages = []
show_debug_overlay = False

def connect_to_arduino():
    """Connect to Arduino on COM5"""
    port = 'COM5'  # Hardcoded COM port
    
    try:
        arduino = serial.Serial(port, 115200, timeout=1)
        time.sleep(2)  # Wait for connection to stabilize
        print(f"Connected to Arduino on {port}")
        return arduino
    except serial.SerialException as e:
        print(f"Error connecting to Arduino on COM5: {e}")
        print("Please check: \n1. Arduino is connected to COM5 \n2. Drivers are installed \n3. No other programs are using COM5")
        return None

# Replace the existing serial connection code with:
arduino_serial = connect_to_arduino()
if arduino_serial is None:
    print("Failed to connect to Arduino on COM5. The program will continue without Arduino input.")

import string

def read_arduino_input():
    if arduino_serial is None:
        return None

    if arduino_serial.in_waiting > 0:
        try:
            raw_data = arduino_serial.readline()
            # Keep only printable characters
            line = ''.join(chr(b) for b in raw_data if chr(b) in string.printable).strip()
            if line:
                print(f"Received from Arduino: {line}")  # Debug output

            if line == 'BUTTON_PRESSED':
                print("Arduino Button Pressed")
                return 'PRESSED'
            elif line == 'BUTTON_RELEASED':
                print("Arduino Button Released")
                return 'RELEASED'
        except Exception as e:
            print(f"Error reading from Arduino: {e}")
    return None





def clear_temp_folder():
    """
    Clears all files and directories inside the 'temp' folder in the main directory.
    """
    temp_folder_path = os.path.join(os.getcwd(), 'temp')  # Assuming 'temp' is in the main directory

    # Check if the specified path exists and is a directory
    if os.path.exists(temp_folder_path) and os.path.isdir(temp_folder_path):
        for filename in os.listdir(temp_folder_path):
            file_path = os.path.join(temp_folder_path, filename)
            try:
                if os.path.isfile(file_path) or os.path.islink(file_path):
                    os.unlink(file_path)  # Remove files or symlinks
                elif os.path.isdir(file_path):
                    shutil.rmtree(file_path)  # Remove directory and all its contents
            except Exception as e:
                print(f'Failed to delete {file_path}. Reason: {e}')
    else:
        print(f"The 'temp' folder does not exist in the main directory.")

    
clear_temp_folder()

# Timing logger
def log_time(start_time, description):
    current_time = time.time()
    print(f"{description}: {current_time - start_time:.4f} seconds")

# Main Program
start_time = time.time()
running = True  # Move this to the top, before starting any threads

log_time(start_time, "Starting")

# Initialize Pygame in Fullscreen Mode with the correct window caption
pygame.init()
pygame.event.set_allowed([pygame.QUIT, pygame.KEYDOWN, pygame.KEYUP, pygame.ACTIVEEVENT])
screen = pygame.display.set_mode((0, 0), pygame.FULLSCREEN)
pygame.display.set_caption('Fluisterbox')
log_time(start_time, "pygame initialized")

# Get the current window size and calculate an auto-resizing font size
width, height = screen.get_size()
auto_font_size = max(30, height // 20)  # Using a divisor of 20 for larger text
font = pygame.font.SysFont(None, auto_font_size)

# Audio settings
chunk = 1024
sample_format = pyaudio.paInt16
channels = 1
rate = 44100
frames = []
# File paths
filename = "recorded_audio.wav"
device_settings_file = "device_settings.json"
whisperbook_file = "whisperbook.json"
text_and_colors_file = "textandcolors.json"
whisper_dir = "whispers"
temp_dir = "temp"

# Function to load or create the whisperbook
def load_or_create_whisperbook():
    if not os.path.exists(whisperbook_file):
        # File doesn't exist, create an empty list
        with open(whisperbook_file, 'w') as json_file:
            json.dump([], json_file, indent=4)
        print(f"Created {whisperbook_file}.")
        return []
    else:
        try:
            # File exists, attempt to load its content
            with open(whisperbook_file, 'r') as json_file:
                return json.load(json_file)
        except json.JSONDecodeError:
            # If the file is empty or contains invalid JSON, initialize it with an empty list
            print(f"Invalid JSON in {whisperbook_file}. Reinitializing it with an empty list.")
            with open(whisperbook_file, 'w') as json_file:
                json.dump([], json_file, indent=4)
            return []
        
# Default text and color values
default_values = {
    "whisper_prompt_text": "Whisper into the mic",
    "whisper_prompt_color": [255, 255, 255],
    "initial_message_text": "Please hold button to record",
    "initial_message_color": [255, 255, 255],
    "whisper_sent_text": "Whisper sent. Thank you!",
    "whisper_sent_color": [0, 255, 0],
    "retry_prompt_text": "Please whisper the name into the mic. Try again.",
    "retry_prompt_color": [255, 255, 0],
    "no_whisper_detected_text": ("No whisper detected.\n"
                                 "Please whisper the name into the mic. Try again."),
    "no_whisper_color": [255, 0, 0],
    "checking_audio_text": "Checking audio file...",
    "checking_audio_color": [255, 255, 0],
    "whisper_thank_you_text": ("Thank you for your whisper.\n"
                               "Would you like to send it in?\n"
                               "Press the spacebar once to send.\n"
                               "Press it twice to try again."),
    "whisper_thank_you_color": [0, 255, 0]
}

# Function to load or create text and color settings
def load_or_create_text_and_colors():
    if not os.path.exists(text_and_colors_file):
        # File doesn't exist, create it with default values
        print("text and colors json not found")
        with open(text_and_colors_file, 'w') as json_file:
            json.dump(default_values, json_file, indent=4)
        return default_values
    else:
        # File exists, load its values
        with open(text_and_colors_file, 'r') as json_file:
            return json.load(json_file)

# Load or create the text and color settings
text_and_colors = load_or_create_text_and_colors()

# Assign the variables from the loaded JSON
whisper_prompt_text = text_and_colors["whisper_prompt_text"]
whisper_prompt_color = tuple(text_and_colors["whisper_prompt_color"])
initial_message_text = text_and_colors["initial_message_text"]
initial_message_color = tuple(text_and_colors["initial_message_color"])
whisper_sent_text = text_and_colors["whisper_sent_text"]
whisper_sent_color = tuple(text_and_colors["whisper_sent_color"])
retry_prompt_text = text_and_colors["retry_prompt_text"]
retry_prompt_color = tuple(text_and_colors["retry_prompt_color"])
no_whisper_detected_text = text_and_colors["no_whisper_detected_text"]
no_whisper_color = tuple(text_and_colors["no_whisper_color"])
checking_audio_text = text_and_colors["checking_audio_text"]
checking_audio_color = tuple(text_and_colors["checking_audio_color"])
whisper_thank_you_text = text_and_colors["whisper_thank_you_text"]
whisper_thank_you_color = tuple(text_and_colors["whisper_thank_you_color"])


# File path for calibration
calibration_file = "calibration.json"
# Default calibration values (includes the new whisper play intervals and Audio Loudness)
default_calibration = {
    "whisper_threshold_value": 0.006,  # Adjust based on experimentation
    "min_whisper_confidence_value": 5.0,  # Minimum confidence for classifying as whisper
    "new_whispers_min_interval": 5.0,  # Minimum interval for playing new whispers (float)
    "new_whispers_max_interval": 10.0,  # Maximum interval for playing new whispers (float)
    "Audio_Loudness": -50.0,  # Standard value for audio loudness in dBFS
    "max_record_duration": 60,  # in seconds (default 60 sec)
    "confirmation_timeout": 10,  # in seconds (default 10 sec)
    "no_whisper_timeout": 3.0  # Added this line
}

# Function to load or create calibration settings (local file only)
def load_or_create_calibration():
    # Start with default calibration settings
    calibration_data = default_calibration.copy()

    # If a local calibration file exists, load and merge it
    if os.path.exists(calibration_file):
        try:
            with open(calibration_file, 'r') as json_file:
                local_calibration = json.load(json_file)
                calibration_data.update(local_calibration)
        except Exception as e:
            print(f"Error reading local calibration file: {e}")

    # Write out the calibration data back to the local file (to create it if necessary)
    with open(calibration_file, 'w') as json_file:
        json.dump(calibration_data, json_file, indent=4)

    print("Calibration values in use:", calibration_data)
    return calibration_data

# Load or create the calibration file
calibration_values = load_or_create_calibration()
current_whisper_playing = False
# Convert relevant settings to float
for key in calibration_values:
    if isinstance(calibration_values[key], str) and calibration_values[key].replace('.', '', 1).isdigit():
        calibration_values[key] = float(calibration_values[key])

# Use the new Audio_Loudness value as a global variable
Audio_Loudness = calibration_values.get("Audio_Loudness", -30.0)
new_whispers_min_interval = calibration_values.get("new_whispers_min_interval", 1.0)
new_whispers_max_interval = calibration_values.get("new_whispers_max_interval", 5.0)
max_record_duration = calibration_values.get("max_record_duration", 60)  # in seconds (default 60 sec)
confirmation_timeout = calibration_values.get("confirmation_timeout", 10)  # in seconds (default 10 sec)
no_whisper_timeout = calibration_values.get("no_whisper_timeout", 3.0)  # Add this line

# Deque to track past whispers with a maximum length of 30
past_whispers = deque(maxlen=30)
new_whispers = deque()  # Deque to track newly added whispers
new_whispers_play_count = 0  # Counter to track how many whispers played since a new whisper was added

# Deque to track past whispers (initial size will be 30% of total whispers)
past_whispers = deque()
new_whispers = deque()  # Deque to track newly added whispers
new_whispers_play_count = 0  # Counter to track how many whispers played since a new whisper was added

# Updated function to add a new whisper entry to the whisperbook
def add_to_whisperbook(filename, confidence, transcription):
    whisperbook = load_or_create_whisperbook()

    # Extract only the filename, not the full path
    base_filename = os.path.basename(filename)

    # Create a new entry for the whisper
    new_entry = {
        "filename": base_filename,  # Save only the base filename
        "confidence": float(confidence),  # Convert to a standard float
        "transcription": transcription,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")
    }

    # Add the new entry to the whisperbook
    whisperbook.append(new_entry)

    # Save the updated whisperbook
    with open(whisperbook_file, 'w') as json_file:
        json.dump(whisperbook, json_file, indent=4)
    print(f"Added new whisper to {whisperbook_file}: {new_entry}")

# Function to calculate and update the length of the past whispers queue
def update_past_whispers_length(whisper_folder):
    global past_whispers
    # Get the number of .wav files in the whispers folder
    total_whispers = len([f for f in os.listdir(whisper_folder) if f.endswith(".wav")])
    
    # Set the past_whispers deque length to 30% of total whispers (at least 1)
    new_length = max(1, int(total_whispers * 0.3))
    
    # Update deque's maxlen dynamically
    past_whispers = deque(past_whispers, maxlen=new_length)
    print(f"Updated past whispers queue size to {new_length}")

# Clean up whisper folder
def clean_whisper_folder():
    whisperbook = load_or_create_whisperbook()
    valid_files = {entry['filename'] for entry in whisperbook}
    
    # Iterate through files in the whisper folder
    for filename in os.listdir(whisper_dir):
        file_path = os.path.join(whisper_dir, filename)
        if filename not in valid_files:
            # Move unlisted files to lost_sounds folder
            lost_sounds_path = os.path.join(os.getcwd(), 'lost_sounds')
            os.makedirs(lost_sounds_path, exist_ok=True)
            shutil.move(file_path, os.path.join(lost_sounds_path, filename))
            print(f"Moved unused file to lost_sounds: {filename}")

# Ensure clean whisper folder during startup
clean_whisper_folder()

def lazy_initialize_librosa(rate, sample_length=0.1, n_fft=256):
    """Initialize Librosa in the background without blocking."""
    def background_init():
        dummy_audio = np.zeros(int(rate * sample_length), dtype=np.float32)  # Small silent audio buffer
        librosa.stft(dummy_audio, n_fft=n_fft, hop_length=n_fft // 2)  # Dummy STFT to initialize
        print("Librosa initialized in the background.")

    init_thread = threading.Thread(target=background_init, daemon=True)  # Set the thread as daemon
    init_thread.start()

# Ensure this runs asynchronously during the main execution
lazy_initialize_librosa(rate)



log_time(start_time, "Librosa Initialization Started")

log_time(start_time, "Audio Pre-warm Completed")




# Create whispers and temp folders if they don't exist
if not os.path.exists(whisper_dir):
    os.makedirs(whisper_dir)
if not os.path.exists(temp_dir):
    os.makedirs(temp_dir)

def list_audio_devices(p):
    """List all available audio input devices"""
    devices = []
    for i in range(p.get_device_count()):
        dev_info = p.get_device_info_by_index(i)
        if dev_info.get('maxInputChannels', 0) > 0:
            devices.append({
                'index': dev_info['index'],
                'name': dev_info['name'],
                'rate': dev_info['defaultSampleRate']
            })
    return devices

def pre_warm_audio():
    global rate
    MAX_ATTEMPTS = 3
    attempt = 0

    # Check that some input device is available
    if p.get_device_count() == 0:
        print("No audio devices found. Please ensure your microphone is connected and enabled.")
        exit()

    # Allow a brief delay for the audio device to settle
    time.sleep(2)

    while attempt < MAX_ATTEMPTS:
        try:
            print(f"\n=== Audio Initialization Attempt {attempt+1}/{MAX_ATTEMPTS} ===")
            default_dev = p.get_default_input_device_info()
            print(f"Default Device: {default_dev['name']}")
            print(f"Supported Rate: {default_dev['defaultSampleRate']}Hz")
            print(f"Max Channels: {default_dev['maxInputChannels']}")

            # Use the device's natural sample rate
            native_rate = int(default_dev['defaultSampleRate'])
            stream = p.open(
                format=sample_format,
                channels=min(channels, int(default_dev['maxInputChannels'])),
                rate=native_rate,
                frames_per_buffer=chunk,
                input=True,
                input_device_index=default_dev['index']
            )
            # Let the stream run briefly (without reading data) to verify that it can start
            time.sleep(0.5)
            stream.stop_stream()
            stream.close()
            
            rate = native_rate  # Update the global rate
            print(f"Audio initialized successfully at {rate}Hz")
            return

        except Exception as e:
            print(f"Attempt {attempt+1} failed: {str(e)}")
            attempt += 1
            time.sleep(1)  # Wait a moment before retrying

    print("\nWARNING: Failed to initialize audio. Microphone functionality will be disabled.")
    global mic_enabled
    mic_enabled = False
    return




# Initialize PyAudio with error handling (make sure this comes before calling pre_warm_audio)
try:
    p = pyaudio.PyAudio()
    print("PyAudio initialized successfully")
except Exception as e:
    print(f"Error initializing PyAudio: {e}")
    exit()
# Initialize pygame mixer at the start
pygame.mixer.init()
mic_enabled = True

def normalize_audio_file(input_filename, output_filename, target_dBFS=Audio_Loudness):
    """Normalize the audio file to the target dBFS level."""
    import numpy as np
    import soundfile as sf

    # Load the audio data
    audio_data, sample_rate = sf.read(input_filename)

    # Calculate RMS in dBFS
    rms = np.sqrt(np.mean(audio_data ** 2))
    current_dBFS = 20 * np.log10(rms + 1e-6)

    # Calculate the gain needed to reach target_dBFS
    gain = 10 ** ((target_dBFS - current_dBFS) / 20)

    # Apply the gain
    normalized_audio = audio_data * gain

    # Ensure the normalized audio is within valid range [-1, 1]
    normalized_audio = np.clip(normalized_audio, -1.0, 1.0)

    # Save the normalized audio to the output file
    sf.write(output_filename, normalized_audio, sample_rate)

    return output_filename  # Return the output filename



def cut_fixed_end(audio_data, sample_rate, cut_duration=0.2):
    """
    Cuts a fixed amount of time from the end of the audio to remove the button release sound.
    
    Parameters:
        audio_data (np.ndarray): The raw audio data as a numpy array.
        sample_rate (int): The sampling rate of the audio.
        cut_duration (float): The duration (in seconds) to cut from the end of the audio.
    
    Returns:
        np.ndarray: The audio with the end cut.
    """
    # Calculate how many samples to remove from the end
    cut_samples = int(cut_duration * sample_rate)
    
    # Return the audio data without the last `cut_samples` samples
    return audio_data[:-cut_samples] if cut_samples < len(audio_data) else audio_data



def extract_significant_audio(frames, sample_rate, frame_size=1024, hop_length=512, energy_threshold=0.02, padding_duration=0.5, cut_end_duration=0.2):
    """
    Extracts all significant audio segments from the recorded frames and removes a fixed duration at the end
    for the button click.
    
    Parameters:
        frames (list): List of recorded audio frames.
        sample_rate (int): The sampling rate of the audio.
        frame_size (int): The size of each frame for energy calculation.
        hop_length (int): The hop length between frames.
        energy_threshold (float): Minimum energy threshold to consider a frame as containing sound.
        padding_duration (float): Additional duration (in seconds) to add before and after the detected segment to avoid cutting speech.
        cut_end_duration (float): The duration (in seconds) to cut from the end for button click removal.
    
    Returns:
        bytes: The extracted and processed audio segment as bytes.
    """
    # Combine frames and convert to NumPy array
    audio_data = np.frombuffer(b''.join(frames), dtype=np.int16).astype(np.float32)
    
    # Normalize the audio data to the range [-1, 1]
    audio_data /= np.max(np.abs(audio_data))
    
    # Cut a fixed duration from the end to remove the button click
    audio_data = cut_fixed_end(audio_data, sample_rate, cut_duration=cut_end_duration)
    
    # Calculate padding length in samples
    padding_length = int(padding_duration * sample_rate)
    
    # Calculate short-term energy using librosa's RMS function
    energies = librosa.feature.rms(y=audio_data, frame_length=frame_size, hop_length=hop_length).flatten()
    
    # Find regions where the energy is above the threshold
    significant_indices = np.where(energies > energy_threshold)[0]
    
    if len(significant_indices) == 0:
        # If no valid sound energy is found, return empty bytes or handle as needed
        print("No significant audio detected.")
        return b''
    
    # Convert frame indices to sample indices
    significant_samples = np.array([i * hop_length for i in significant_indices])
    
    # Find continuous regions of significant audio and extract them
    start_sample = max(0, significant_samples[0] - padding_length)
    end_sample = min(len(audio_data), significant_samples[-1] + padding_length)
    
    # Extract the audio segment, ensuring there's padding before and after the sound
    extracted_audio = audio_data[start_sample:end_sample]
    
    # Convert back to bytes
    extracted_audio_bytes = (extracted_audio * np.iinfo(np.int16).max).astype(np.int16).tobytes()
    
    return extracted_audio_bytes

def save_recording(save_dir):
    global frames, rate, channels, p, sample_format
    timestamp = time.strftime("%d-%m-%Y_%H-%M-%S")
    temp_filename = f"whisper_{timestamp}.tmp"  # Save as temporary file first
    final_filename = f"whisper_{timestamp}.wav"  # Final filename
    temp_file_path = os.path.join(os.path.abspath(save_dir), temp_filename)
    final_file_path = os.path.join(os.path.abspath(save_dir), final_filename)
    
    # Extract the most prominent audio segment
    extracted_audio_bytes = extract_significant_audio(
        frames, rate, frame_size=1024, hop_length=512,
        energy_threshold=0.02, padding_duration=0.5
    )

    # Write the cropped audio to the temporary file
    with wave.open(temp_file_path, 'wb') as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(p.get_sample_size(sample_format))
        wf.setframerate(rate)
        wf.writeframes(extracted_audio_bytes)
    
    # Rename the temp file to the final .wav file
    os.rename(temp_file_path, final_file_path)
    
    # Add the new whisper to the deque (new whispers)
    new_whispers.append(final_file_path)
    new_whispers_play_count = random.randint(5, 10)  # It will be played after 5-10 other whispers
    
    # Update past whispers length dynamically
    update_past_whispers_length(save_dir)
    
    print(f"Recording saved as {final_file_path}")
    clean_whisper_folder()
    return final_file_path

def list_audio_devices(p):
    device_count = p.get_device_count()
    input_devices = []
    for i in range(device_count):
        device_info = p.get_device_info_by_index(i)
        if device_info['maxInputChannels'] > 0:
            input_devices.append(device_info)
    return input_devices

def pre_warm_audio():
    stream = p.open(format=sample_format, channels=channels, rate=rate, frames_per_buffer=chunk, input=True)
    stream.read(chunk)
    stream.stop_stream()
    stream.close()

# Call this function at the start of the program
try:
    pre_warm_audio()
except Exception as e:
    print("Pre-warm audio failed with error:", e)
    mic_enabled = False

def save_selected_device_index(index):
    with open(device_settings_file, "w") as f:
        json.dump({"selected_device_index": index}, f)

def load_selected_device_index():
    if os.path.exists(device_settings_file):
        with open(device_settings_file, "r") as f:
            data = json.load(f)
            return data.get("selected_device_index", 0)
    return 0

def get_auto_font_for_message(message, margin_ratio=0.1, min_size=30):
    """
    Return a font that maximizes the displayed text size so that all lines fit within the screen.
    The available space is the full screen size (optionally reduced by a margin_ratio, where 0 means no margin).
    This implementation uses a binary search to find the maximum font size that fits.
    """
    width, height = screen.get_size()
    available_width = width * (1 - margin_ratio)
    available_height = height * (1 - margin_ratio)
    lines = message.split('\n')

    def fits(font_size):
        font_candidate = pygame.font.SysFont(None, font_size)
        # Check that each line fits horizontally:
        if any(font_candidate.render(line, True, (255, 255, 255)).get_width() > available_width for line in lines):
            return False
        # Check that the total height of all lines fits vertically:
        total_height = sum(font_candidate.render(line, True, (255, 255, 255)).get_height() for line in lines)
        return total_height <= available_height

    low = min_size
    # A rough upper bound: available_height (the text height cannot exceed the screen height)
    high = int(available_height)
    best = min_size
    while low <= high:
        mid = (low + high) // 2
        if fits(mid):
            best = mid
            low = mid + 1
        else:
            high = mid - 1
    return pygame.font.SysFont(None, best)

def display_message_centered(message, color=(255, 255, 255)):
    """Display message centered on screen with proper text handling"""
    # Ensure we're only using text from text_and_colors
    if message not in [
        text_and_colors["whisper_prompt_text"],
        text_and_colors["initial_message_text"],
        text_and_colors["whisper_sent_text"],
        text_and_colors["retry_prompt_text"],
        text_and_colors["no_whisper_detected_text"],
        text_and_colors["checking_audio_text"],
        text_and_colors["whisper_thank_you_text"]
    ]:
        debug_print(f"Warning: Unexpected message text: {message}")
        return

    # Create a temporary surface for double buffering
    temp_surface = pygame.Surface(screen.get_size())
    temp_surface.fill((0, 0, 0))  # Clear with black
    
    # Get font and render text
    font = get_auto_font_for_message(message)
    lines = message.split('\n')
    
    # Calculate total height of all lines
    total_height = sum(font.render(line, True, color).get_height() for line in lines)
    y_offset = (height - total_height) // 2
    
    # Render each line
    for line in lines:
        text = font.render(line, True, color)
        text_rect = text.get_rect(center=(width // 2, y_offset + text.get_height() // 2))
        temp_surface.blit(text, text_rect)
        y_offset += text.get_height()
    
    # Add debug overlay if active
    if show_debug_overlay:
        debug_font = pygame.font.SysFont(None, 30)
        debug_y = 20
        for debug_msg in debug_messages[-20:]:
            debug_text = debug_font.render(debug_msg, True, (255, 255, 255))
            temp_surface.blit(debug_text, (20, debug_y))
            debug_y += 35
    
    # Blit everything to screen at once
    screen.blit(temp_surface, (0, 0))
    pygame.display.flip()

# Add debug print when loading text_and_colors
print("Loaded text and colors:", json.dumps(text_and_colors, indent=2))

def mute_audio():
    """Mute all pygame audio channels"""
    for i in range(pygame.mixer.get_num_channels()):
        channel = pygame.mixer.Channel(i)
        channel.set_volume(0.0)
    debug_print("Audio muted")

def unmute_audio():
    """Restore volume to all pygame audio channels"""
    for i in range(pygame.mixer.get_num_channels()):
        channel = pygame.mixer.Channel(i)
        channel.set_volume(1.0)
    debug_print("Audio unmuted")

def handle_recording_confirmation(file_path):
    global is_in_confirmation, new_whispers, current_whisper_playing
    is_in_confirmation = True
    press_count = 0
    unmute_audio()  # Unmute audio when entering confirmation
    
    confirmation_start_time = time.time()   # Start confirmation timer
    
    # Display "Checking audio file" while the transcription is being processed
    display_message_centered(checking_audio_text, checking_audio_color)
    
    # Wait for the transcription result (get transcription and classification)
    transcription, speech_type, confidence = transcribe_audio(file_path)
    
    if speech_type == "whisper":
        # Create a temp normalized file for playback during confirmation
        temp_normalized_file = file_path.replace('.wav', '_normalized.wav')
        normalize_audio_file(file_path, temp_normalized_file)
        
        # If normalization failed, handle the error
        if not os.path.exists(temp_normalized_file):
            display_message_centered("Error processing audio.", (255, 0, 0))
            print("Error: Normalized audio file not found.")
            is_in_confirmation = False
            return
        
        # Thank the user and offer send options
        message = whisper_thank_you_text
        display_message_centered(message, whisper_thank_you_color)  # Green for whisper detected
        
        # Start playing back the normalized audio every 3 seconds
        start_time = time.time()
        current_whisper_playing = play_audio(temp_normalized_file)
        
        # Now handle the logic for send or try again
        first_press_time = None
        waiting_for_decision = True
        
        while waiting_for_decision:
            # Check for confirmation timeout
            if time.time() - confirmation_start_time >= confirmation_timeout:
                print("Confirmation timeout reached, discarding recording.")
                waiting_for_decision = False
                press_count = 0
                break

            # Play the audio back every 3 seconds while waiting for a decision
            if (time.time() - start_time) >= 3:
                current_whisper_playing = play_audio(temp_normalized_file)
                start_time = time.time()  # Reset the timer
            
            press_detected = False  # Initialize at the start of each loop
            input_source = None  # To track the input source (optional)
            
            # Handle Pygame events
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    pygame.quit()
                    exit()
                
                # Check for space key press
                if event.type == pygame.KEYDOWN and event.key == pygame.K_SPACE:
                    press_detected = True
                    input_source = 'Pygame'
                    print("Space key pressed")
                    break  # Exit the for loop if event is detected
            
            # Check for Arduino button press outside the for loop
            if not press_detected:
                arduino_event = read_arduino_input()
                if arduino_event == 'PRESSED':
                    press_detected = True
                    input_source = 'Arduino'
                    print("Arduino button pressed")
            
            # Process the press detection
            if press_detected:
                # Record the first press time
                if press_count == 0:
                    press_count += 1
                    first_press_time = time.time()  # Store the time of the first press
                    print(f"First press detected from {input_source}")
                # If there's a second press within 1 second, consider it a double press
                elif press_count == 1 and (time.time() - first_press_time) < 1:
                    press_count += 1
                    waiting_for_decision = False  # Exit loop after the second press
                    print(f"Second press detected from {input_source}, double press confirmed")
            
            # After 1 second without a second press, treat it as a single press
            if press_count == 1 and (time.time() - first_press_time) >= 1:
                waiting_for_decision = False  # Exit loop to process single press
                print("Single press confirmed after timeout")
            
            # Small delay to prevent high CPU usage
            time.sleep(0.01)
        
        # Process the decision after button presses
        if press_count == 1:
            # Single press: Send the whisper (copy it to the 'whispers' folder)
            # But first, stop any playing audio
            stop_audio(current_whisper_playing)
            
            # Delete the temp normalized file
            if os.path.exists(temp_normalized_file):
                try:
                    os.remove(temp_normalized_file)
                except Exception as e:
                    print(f"Error deleting temp normalized file: {e}")
            
            whisper_folder = 'whispers'
            if not os.path.exists(whisper_folder):
                os.makedirs(whisper_folder)  # Create the folder if it doesn't exist
            
            # Generate a new filename for the whisper in the 'whispers' folder
            timestamp = time.strftime("%d-%m-%Y_%H-%M-%S")
            whisper_filename = f"whisper_{timestamp}.wav"
            final_file_path = os.path.join(whisper_folder, whisper_filename)
            
            try:
                # Copy the original file to the 'whispers' folder
                shutil.copy2(file_path, final_file_path)
                print(f"Recording copied to {final_file_path}")
            except Exception as e:
                print(f"Error copying file: {e}")
                display_message_centered("Failed to save the whisper.", (255, 0, 0))
                is_in_confirmation = False
                return
            
            rounded_confidence = round(confidence, 1)
            add_to_whisperbook(final_file_path, rounded_confidence, transcription)
            
            # Add the filename to new_whispers
            new_whispers.append(whisper_filename)
            
            display_message_centered(whisper_sent_text, whisper_sent_color)
            print("Whisper sent")
            
            # Display initial message after 2 seconds
            time.sleep(2)
            display_message_centered(initial_message_text, initial_message_color)
        elif press_count == 2:
            # Double press: Retry recording
            stop_audio(current_whisper_playing)
            
            # Delete the temp normalized file
            if os.path.exists(temp_normalized_file):
                try:
                    os.remove(temp_normalized_file)
                except Exception as e:
                    print(f"Error deleting temp normalized file: {e}")
            
            display_message_centered(retry_prompt_text, retry_prompt_color)
            print("Retry recording requested")
            # Reset for a new recording
    
    else:
        # If no whisper was detected, show a prompt for 2 seconds then go back to the main text
        message = no_whisper_detected_text
        display_message_centered(message, no_whisper_color)  # Red color for no whisper
        print("No whisper detected.")
        time.sleep(no_whisper_timeout)  # Use the configured timeout
        display_message_centered(initial_message_text, initial_message_color)
    
    # After processing the decision (whether single or double press)
    # Make sure to properly reset all states
    is_in_confirmation = False
    current_whisper_playing = None
    
    # Clear any remaining pygame events to prevent unwanted behavior
    pygame.event.clear()
    
    # Ensure mixer is ready for new playback
    pygame.mixer.stop()  # Stop any lingering sounds
    pygame.mixer.init()  # Reinitialize mixer
    
    # Display initial message and allow a brief moment for states to reset
    display_message_centered(initial_message_text, initial_message_color)
    time.sleep(0.1)  # Short delay to ensure states are reset
    
    debug_print("Confirmation complete - whisper playback should resume")

# Main loop and event handling
devices = list_audio_devices(p)
dropdown_open = False
selected_device_index = load_selected_device_index()
# Ensure selected_device_index is an integer
selected_device_index = int(selected_device_index) if selected_device_index else 0

# Ensure it is within bounds of the available devices
selected_device_index = min(selected_device_index, len(devices) - 1) if devices else 0
stream = None
is_recording = False
play_whispers_during_recording = False
is_in_confirmation = False
display_message_centered(initial_message_text, initial_message_color)  # Show initial message

def play_random_whisper(whisper_folder):
    global new_whispers_play_count, is_recording, is_in_confirmation, current_whisper_playing, past_whispers
    global running, new_whispers_min_interval, new_whispers_max_interval

    next_whisper_time = time.time()  # Initialize next whisper time
    debug_print(f"Whisper player started - Min interval: {new_whispers_min_interval}s, Max interval: {new_whispers_max_interval}s")

    while running:
        try:
            current_time = time.time()
            
            # Add state tracking debug output
            if current_time % 5 < 0.1:  # Print state every ~5 seconds
                debug_print(f"Whisper loop state - Recording: {is_recording}, Confirmation: {is_in_confirmation}")
                debug_print(f"Time until next whisper: {max(0, next_whisper_time - current_time):.1f}s")

            # Only play whispers when not recording or confirming AND it's time for the next whisper
            if not is_recording and not is_in_confirmation and current_time >= next_whisper_time:
                debug_print("Checking for available whispers...")
                
                # Get all whisper files in the folder (only .wav files)
                whisper_files = [f for f in os.listdir(whisper_folder) if f.endswith(".wav")]

                if not whisper_files:
                    debug_print("No whisper files found in folder")
                    time.sleep(1)
                    continue

                # Prioritize playing new whispers if they exist and the count has reached its limit
                if new_whispers and new_whispers_play_count <= 0:
                    random_whisper = new_whispers.popleft()
                    debug_print(f"Playing new whisper: {random_whisper}")
                else:
                    # Filter out past whispers from the random selection
                    available_whispers = [f for f in whisper_files if f not in past_whispers]

                    if not available_whispers:
                        available_whispers = whisper_files
                        past_whispers.clear()
                        debug_print("Reset past whispers list - all whispers available again")

                    # Select a random whisper
                    random_whisper = random.choice(available_whispers)
                    past_whispers.append(random_whisper)
                    debug_print(f"Playing random whisper: {random_whisper}")

                    if new_whispers_play_count > 0:
                        new_whispers_play_count -= 1
                        debug_print(f"Decreased new whispers play count to {new_whispers_play_count}")

                # Process and play the whisper
                whisper_path = os.path.join(whisper_folder, random_whisper)
                temp_normalized_filename = f"playback_{random_whisper}"
                temp_normalized_file = os.path.join('temp', temp_normalized_filename)

                # Normalize the audio file
                normalize_audio_file(whisper_path, temp_normalized_file)

                if not os.path.exists(temp_normalized_file):
                    debug_print(f"Error: Normalized file not found for {random_whisper}")
                    continue

                # Play the normalized whisper file
                current_channel = play_audio(temp_normalized_file)
                if current_channel:
                    debug_print("Whisper playback started successfully")
                    # Schedule next whisper time
                    interval = random.uniform(new_whispers_min_interval, new_whispers_max_interval)
                    next_whisper_time = current_time + interval
                    debug_print(f"Next whisper scheduled in {interval:.1f}s")
                else:
                    debug_print("Failed to start whisper playback")
                    next_whisper_time = current_time + 1  # Retry after 1 second on failure

            else:
                # Small sleep to prevent CPU overuse
                time.sleep(0.1)
                
        except Exception as e:
            debug_print(f"Error in whisper playback: {e}")
            time.sleep(1)
            next_whisper_time = time.time() + 1  # Reset timer after error


# Thread to continuously play random whispers
def start_random_whispers(whisper_folder):
    threading.Thread(target=play_random_whisper, args=(whisper_folder,), daemon=True).start()

# Function to play audio and return a reference to the audio channel (for stopping later)
def play_audio(file_path):
    """Play audio using pygame.mixer.Sound for overlapping playback"""
    try:
        sound = pygame.mixer.Sound(file_path)
        channel = pygame.mixer.find_channel()
        if channel:
            channel.play(sound)
            return channel
        else:
            print("No available audio channels.")
            return None
    except Exception as e:
        print(f"Error playing audio: {e}")
        return None

def wait_for_playback_to_finish(music_object):
    while music_object.get_busy():
        pygame.time.Clock().tick(100)  # Wait for playback to finish



def stop_audio(music_object):
    music_object.stop()
    # Don't unload or stop the mixer, just stop the specific sound
    debug_print("Audio stopped")

def cleanup_temp_files():
    """Clean up temp files that are no longer in use"""
    temp_dir = 'temp'
    if os.path.exists(temp_dir):
        for filename in os.listdir(temp_dir):
            file_path = os.path.join(temp_dir, filename)
            try:
                os.remove(file_path)
            except Exception as e:
                debug_print(f"Error deleting temp file {filename}: {e}")

# Example usage: Start random whispers (call this at the start of your script)
whisper_folder = "whispers"
update_past_whispers_length(whisper_folder)  # Initialize the past whispers queue size
start_random_whispers(whisper_folder)
debug_print("Started random whispers thread")

def draw_debug_overlay():
    """Draw the debug overlay on the screen"""
    debug_font = pygame.font.SysFont(None, 30)
    overlay = pygame.Surface(screen.get_size(), pygame.SRCALPHA)
    overlay.fill((0, 0, 0, 200))  # Semi-transparent dark background
    
    y_offset = 20
    for message in debug_messages[-20:]:  # Show last 20 messages
        text = debug_font.render(message, True, (255, 255, 255))
        overlay.blit(text, (20, y_offset))
        y_offset += 35
    
    screen.blit(overlay, (0, 0))

# Add near the top with other global variables
last_redraw_time = time.time()
REDRAW_INTERVAL = 3.0  # Redraw every 3 seconds

# Modify the main loop to include periodic redraw
while running:
    current_time = time.time()
    
    # Periodic screen refresh (only if nothing else is actively updating the screen)
    if current_time - last_redraw_time >= REDRAW_INTERVAL:
        if not is_recording and not is_in_confirmation:  # Don't interrupt active states
            display_message_centered(initial_message_text, initial_message_color)
            last_redraw_time = current_time
    
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False
            break
        elif event.type == pygame.ACTIVEEVENT:
            # Check if window gained focus (was alt-tabbed back to)
            if event.gain:  # Simplified check for any focus gain
                debug_print("Window regained focus - forcing screen redraw")
                if is_recording:
                    display_message_centered(whisper_prompt_text, whisper_prompt_color)
                elif not is_in_confirmation:
                    display_message_centered(initial_message_text, initial_message_color)
                last_redraw_time = current_time  # Reset the timer after manual redraw
        elif event.type == pygame.KEYDOWN:
            if event.key == pygame.K_ESCAPE:      # Exit if Escape is pressed
                running = False
                debug_print("Exiting program")
                break
            elif event.key == pygame.K_SPACE and not is_recording and devices:
                # Start recording when space key is pressed
                is_recording = True
                debug_print(f"State: Recording={is_recording}, Confirmation={is_in_confirmation}")
                debug_print("Recording started - muting audio")
                mute_audio()  # Mute audio when starting recording
                record_start_time = time.time()
                display_message_centered(whisper_prompt_text, whisper_prompt_color)
                stream = p.open(format=sample_format, channels=channels, rate=rate, input=True,
                                input_device_index=devices[selected_device_index]['index'], frames_per_buffer=chunk)
                frames = []
                debug_print("Started recording")
            elif event.key == pygame.K_TAB:
                show_debug_overlay = True
                debug_print("TAB PRESSED - Showing debug overlay")
                debug_print(f"State: Recording={is_recording}, Confirmation={is_in_confirmation}")
                display_message_centered(initial_message_text, initial_message_color)  # Force refresh
        elif event.type == pygame.KEYUP and not is_in_confirmation:
            if event.key == pygame.K_TAB:
                show_debug_overlay = False
                debug_print("TAB RELEASED - Hiding debug overlay")
                display_message_centered(initial_message_text, initial_message_color)  # Force refresh

    # Check for Arduino button press outside of Pygame events
    arduino_event = read_arduino_input()
    if arduino_event == 'PRESSED' and not is_recording and devices:
        # Start recording when Arduino button is pressed
        is_recording = True
        debug_print(f"State: Recording={is_recording}, Confirmation={is_in_confirmation}")
        debug_print("Recording started - muting audio")
        mute_audio()  # Mute audio when starting recording
        record_start_time = time.time()
        display_message_centered(whisper_prompt_text, whisper_prompt_color)
        stream = p.open(format=sample_format, channels=channels, rate=rate, input=True,
                        input_device_index=devices[selected_device_index]['index'], frames_per_buffer=chunk)
        frames = []
        debug_print("Started recording")

    # If recording, read audio data and check for stop conditions
    if is_recording:
        data = stream.read(chunk, exception_on_overflow=False)
        frames.append(data)
        debug_print(f"Recording frame {len(frames)}")
        # Automatically stop recording if max duration exceeded
        if time.time() - record_start_time >= max_record_duration:
            print("Max record duration reached, stopping recording automatically.")
            stream.stop_stream()
            stream.close()
            is_recording = False
            recorded_file = save_recording(temp_dir)
            handle_recording_confirmation(recorded_file)
            continue

        # Handle Pygame events for stopping recording
        for stop_event in pygame.event.get():
            if stop_event.type == pygame.KEYUP and stop_event.key == pygame.K_SPACE:
                # Stop recording when space key is released
                stream.stop_stream()
                stream.close()
                is_recording = False
                recorded_file = save_recording(temp_dir)
                handle_recording_confirmation(recorded_file)
                break
            elif stop_event.type == pygame.QUIT:
                running = False
                is_recording = False
                break

        # Check for Arduino button release to stop recording
        arduino_event = read_arduino_input()
        if arduino_event == 'RELEASED':
            # Stop recording when Arduino button is released
            stream.stop_stream()
            stream.close()
            is_recording = False
            recorded_file = save_recording(temp_dir)
            handle_recording_confirmation(recorded_file)

    # Always draw debug overlay last if active
    if show_debug_overlay:
        draw_debug_overlay()
    
    pygame.display.update()

pygame.quit()
p.terminate()
sys.exit()
debug_print("Program exited cleanly")