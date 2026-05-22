import os
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
import serial
import soundfile as sf
import shutil
# Make sure to replace 'COM3' with the correct port for your Arduino
try:
    arduino_serial = serial.Serial('COM3', 115200, timeout=1)  # Update to the correct port
    time.sleep(2)  # Wait for 2 seconds for the connection to stabilize
except serial.SerialException as e:
    print(f"Error opening serial port: {e}")
    exit()

import string

def read_arduino_input():
    if arduino_serial.in_waiting > 0:
        try:
            raw_data = arduino_serial.readline()
            # Keep only printable characters
            line = ''.join(chr(b) for b in raw_data if chr(b) in string.printable).strip()
            if line:
                print(f"Received from Arduino: {line}")  # Print everything received for debugging
                
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

log_time(start_time, "Starting")

# Initialize Pygame
pygame.init()

log_time(start_time, "pygame initialized")

font = pygame.font.SysFont(None, 30)

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
    "Audio_Loudness": -50.0  # Standard value for audio loudness in dBFS
}

# Function to load or create calibration settings
def load_or_create_calibration():
    if not os.path.exists(calibration_file):
        # Create file with default values if it doesn't exist
        with open(calibration_file, 'w') as json_file:
            json.dump(default_calibration, json_file, indent=4)
        return default_calibration

    with open(calibration_file, 'r') as json_file:
        calibration_data = json.load(json_file)

    # Fill missing keys with default values and save if necessary
    updated = False
    for key, value in default_calibration.items():
        if key not in calibration_data:
            calibration_data[key] = value
            updated = True

    if updated:
        with open(calibration_file, 'w') as json_file:
            json.dump(calibration_data, json_file, indent=4)

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

# Pygame Initialization
pygame.init()
width = 1000
height = 1000
screen = pygame.display.set_mode((width, height))
pygame.display.set_caption('Select Audio Device & Record')
log_time(start_time, "Pygame Window Loaded")

log_time(start_time, "Audio Pre-warm Completed")




# Create whispers and temp folders if they don't exist
if not os.path.exists(whisper_dir):
    os.makedirs(whisper_dir)
if not os.path.exists(temp_dir):
    os.makedirs(temp_dir)

def pre_warm_audio():
    stream = p.open(format=sample_format, channels=channels, rate=rate, frames_per_buffer=chunk, input=True)
    stream.read(chunk)
    stream.stop_stream()
    stream.close()




# Initialize PyAudio
p = pyaudio.PyAudio()
# Initialize pygame mixer at the start
pygame.mixer.init()

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
pre_warm_audio()

def save_selected_device_index(index):
    with open(device_settings_file, "w") as f:
        json.dump({"selected_device_index": index}, f)

def load_selected_device_index():
    if os.path.exists(device_settings_file):
        with open(device_settings_file, "r") as f:
            data = json.load(f)
            return data.get("selected_device_index", 0)
    return 0

def display_message(message, color=(255, 255, 255)):
    screen.fill((0, 0, 0))
    lines = message.split('\n')
    y_offset = 150
    for line in lines:
        text = font.render(line, True, color)
        screen.blit(text, (20, y_offset))
        y_offset += text.get_height() + 5
    pygame.display.update()





def draw_dropdown(devices, selected_index, dropdown_open):
    # Position and size of the dropdown
    dropdown_x, dropdown_y = 20, 20
    button_width, button_height = 360, 40
    device_height = 40

    # Draw the dropdown button
    pygame.draw.rect(screen, (100, 100, 100), (dropdown_x, dropdown_y, button_width, button_height))
    if devices:
        current_device_text = font.render(f"{selected_index + 1}: {devices[selected_index]['name']}", True, (255, 255, 255))
    else:
        current_device_text = font.render("No Input Devices Found", True, (255, 255, 255))
    screen.blit(current_device_text, (dropdown_x + 10, dropdown_y + 5))
    pygame.draw.polygon(screen, (255, 255, 255), [(dropdown_x + button_width - 20, dropdown_y + 15), 
                                                  (dropdown_x + button_width - 10, dropdown_y + 15), 
                                                  (dropdown_x + button_width - 15, dropdown_y + 25)])

    # If dropdown is open, display the list of devices
    if dropdown_open and devices:
        for index, device in enumerate(devices):
            device_y = dropdown_y + button_height + index * device_height
            pygame.draw.rect(screen, (50, 50, 50), (dropdown_x, device_y, button_width, device_height))
            device_text = font.render(f"{index + 1}: {device['name']}", True, (255, 255, 255))
            screen.blit(device_text, (dropdown_x + 10, device_y + 5))
def play_audio(filename):
    pygame.mixer.music.load(filename)
    pygame.mixer.music.play()
    while pygame.mixer.music.get_busy():
        pygame.time.Clock().tick(10)
    pygame.mixer.music.unload()
def write_wave_file(file_path):
    wf = wave.open(file_path, 'wb')
    wf.setnchannels(channels)
    wf.setsampwidth(p.get_sample_size(sample_format))
    wf.setframerate(rate)
    wf.writeframes(b''.join(frames))
    wf.close()

# Prevent redundant normalization and clean up any repeated normalized files
def remove_duplicate_normalized_files(whisper_folder):
    seen_files = set()
    for filename in os.listdir(whisper_folder):
        if '_normalized' in filename:
            base_filename = filename.split('_normalized')[0] + '.wav'
            if base_filename not in seen_files:
                seen_files.add(base_filename)
            else:
                file_path = os.path.join(whisper_folder, filename)
                os.remove(file_path)
                print(f"Removed duplicate normalized file: {filename}")

# Call this function to clean up duplicate normalized files during startup
remove_duplicate_normalized_files(whisper_dir)
def trim_silence_from_frames(frames, sample_rate, threshold=0.02):
    # Convert frames to a 1D NumPy array
    audio_data = np.frombuffer(b''.join(frames), dtype=np.int16).astype(np.float32)
    
    # Normalize the audio data to range [-1, 1]
    audio_data /= np.iinfo(np.int16).max

    # Use librosa to trim silence
    trimmed_audio, index = librosa.effects.trim(audio_data, top_db=threshold*100)
    
    # Convert back to int16
    trimmed_audio = (trimmed_audio * np.iinfo(np.int16).max).astype(np.int16)

    return trimmed_audio.tobytes()

# Function to display messages centered on the screen
def display_message_centered(message, color=(255, 255, 255)):
    screen.fill((0, 0, 0))  # Clear the screen
    lines = message.split('\n')
    
    # Calculate total height of all lines
    total_height = sum([font.render(line, True, color).get_height() for line in lines])
    
    # Start drawing from the middle of the screen, accounting for the total height of the message
    y_offset = (height - total_height) // 2
    
    for line in lines:
        text = font.render(line, True, color)
        text_rect = text.get_rect(center=(width // 2, y_offset + text.get_height() // 2))
        screen.blit(text, text_rect)
        y_offset += text.get_height()
    
    pygame.display.update()

def handle_recording_confirmation(file_path):
    global is_in_confirmation, new_whispers
    is_in_confirmation = True
    press_count = 0  # Ensure it's always defined

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
        # If no whisper was detected, prompt the user to try again
        message = no_whisper_detected_text
        display_message_centered(message, no_whisper_color)  # Red for no whisper
        print("No whisper detected.")

    is_in_confirmation = False  # Mark confirmation as done
    is_in_confirmation = False  # Mark confirmation as done



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
    global new_whispers_min_interval, new_whispers_max_interval  # Ensure these are accessible

    while True:
        # Only play whispers when not in recording mode or confirmation
        if not is_recording and not is_in_confirmation:
            # Get all whisper files in the folder (only .wav files)
            whisper_files = [f for f in os.listdir(whisper_folder) if f.endswith(".wav")]

            if whisper_files:
                # Prioritize playing new whispers if they exist and the count has reached its limit
                if new_whispers and new_whispers_play_count <= 0:
                    random_whisper = new_whispers.popleft()  # Should be filename
                else:
                    # Filter out past whispers from the random selection
                    available_whispers = [f for f in whisper_files if f not in past_whispers]

                    if not available_whispers:
                        available_whispers = whisper_files  # If all whispers have been recently played, reset
                        past_whispers.clear()

                    # Select a random whisper that hasn't been played recently
                    random_whisper = random.choice(available_whispers)
                    # Add the played whisper to the past_whispers deque
                    past_whispers.append(random_whisper)

                    # Decrease the counter if needed
                    if new_whispers_play_count > 0:
                        new_whispers_play_count -= 1

                whisper_path = os.path.join(whisper_folder, random_whisper)

                # Create a temporary normalized file for playback in the 'temp' directory
                temp_dir = 'temp'  # Ensure this directory exists
                if not os.path.exists(temp_dir):
                    os.makedirs(temp_dir)

                temp_normalized_filename = f"playback_{random_whisper}"
                temp_normalized_file = os.path.join(temp_dir, temp_normalized_filename)

                # Normalize the audio file
                normalize_audio_file(whisper_path, temp_normalized_file)

                # Ensure the normalized file exists
                if not os.path.exists(temp_normalized_file):
                    print(f"Normalized file not found for {random_whisper}, skipping.")
                    continue

                # Play the normalized whisper file
                print(f"Playing random whisper: {random_whisper}")
                current_whisper_playing = play_audio(temp_normalized_file)  # Play the normalized audio

                # Wait for playback to finish
                wait_for_playback_to_finish(current_whisper_playing)

                # Stop the audio and release resources
                stop_audio(current_whisper_playing)
                current_whisper_playing = None

                # Delete the temp normalized file after playback
                if os.path.exists(temp_normalized_file):
                    try:
                        os.remove(temp_normalized_file)
                    except Exception as e:
                        print(f"Error deleting temp normalized file: {e}")

                # Wait for a random interval between specified min and max seconds
                random_interval = random.uniform(new_whispers_min_interval, new_whispers_max_interval)
                time.sleep(random_interval)
            else:
                # No whispers to play, sleep briefly
                time.sleep(1)
        else:
            # If recording is active or in confirmation, no whispers should play
            if current_whisper_playing:
                stop_audio(current_whisper_playing)  # Stop any currently playing whisper
                current_whisper_playing = None
            time.sleep(1)  # Sleep briefly to avoid busy waiting


# Thread to continuously play random whispers
def start_random_whispers(whisper_folder):
    threading.Thread(target=play_random_whisper, args=(whisper_folder,), daemon=True).start()

# Function to play audio and return a reference to the audio channel (for stopping later)
def play_audio(file_path):
    # Initialize pygame mixer if not already initialized
    if not pygame.mixer.get_init():
        pygame.mixer.init()
    # Load the audio file
    pygame.mixer.music.load(file_path)
    # Play the audio file
    pygame.mixer.music.play()
    return pygame.mixer.music  # Return the music object to control playback

def wait_for_playback_to_finish(music_object):
    while music_object.get_busy():
        pygame.time.Clock().tick(100)  # Wait for playback to finish



def stop_audio(music_object):
    music_object.stop()
    pygame.mixer.music.unload()
    pygame.mixer.quit()



# Example usage: Start random whispers (call this at the start of your script)
whisper_folder = "whispers"
update_past_whispers_length(whisper_folder)  # Initialize the past whispers queue size
start_random_whispers(whisper_folder)
running = True
while running:
    # Handle Pygame events
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False
            break

        elif event.type == pygame.MOUSEBUTTONDOWN:
            mouse_x, mouse_y = event.pos
            if 20 <= mouse_x <= 380 and 20 <= mouse_y <= 60:
                dropdown_open = not dropdown_open
            if dropdown_open and devices:
                for index, device in enumerate(devices):
                    device_y = 60 + index * 40
                    if 20 <= mouse_x <= 380 and device_y <= mouse_y <= device_y + 40:
                        selected_device_index = index
                        dropdown_open = False
                        save_selected_device_index(selected_device_index)

        elif event.type == pygame.KEYDOWN and event.key == pygame.K_SPACE and not is_recording and devices:
            # Start recording when space key is pressed
            is_recording = True
            display_message_centered(whisper_prompt_text, whisper_prompt_color)
            stream = p.open(format=sample_format, channels=channels, rate=rate, input=True,
                            input_device_index=devices[selected_device_index]['index'], frames_per_buffer=chunk)
            frames = []

    # Check for Arduino button press outside of Pygame events
    arduino_event = read_arduino_input()
    if arduino_event == 'PRESSED' and not is_recording and devices:
        # Start recording when Arduino button is pressed
        is_recording = True
        display_message_centered(whisper_prompt_text, whisper_prompt_color)
        stream = p.open(format=sample_format, channels=channels, rate=rate, input=True,
                        input_device_index=devices[selected_device_index]['index'], frames_per_buffer=chunk)
        frames = []

    # If recording, read audio data and check for stop conditions
    if is_recording:
        data = stream.read(chunk, exception_on_overflow=False)
        frames.append(data)

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



pygame.quit()
p.terminate()