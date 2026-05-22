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
whisper_dir = "whispers"
temp_dir = "temp"
text_and_colors_file = "textandcolors.json"

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


# Deque to track past whispers with a maximum length of 30
past_whispers = deque(maxlen=30)
new_whispers = deque()  # Deque to track newly added whispers
new_whispers_play_count = 0  # Counter to track how many whispers played since a new whisper was added

# Deque to track past whispers (initial size will be 30% of total whispers)
past_whispers = deque()
new_whispers = deque()  # Deque to track newly added whispers
new_whispers_play_count = 0  # Counter to track how many whispers played since a new whisper was added



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

def lazy_initialize_librosa(rate, sample_length=0.1, n_fft=256):
    """Runs the initialization in the background without blocking the main program."""
    def background_init():
        dummy_audio = np.zeros(int(rate * sample_length), dtype=np.float32)
        librosa.stft(dummy_audio, n_fft=n_fft, hop_length=n_fft // 2)
        print("Librosa initialized in the background.")

    init_thread = threading.Thread(target=background_init)
    init_thread.start()

# Call lazy initialization at program startup (but it won't block the main flow)
lazy_initialize_librosa(rate)

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

# Function to save the recording and mark it as ready
def save_recording(save_dir):
    global new_whispers, new_whispers_play_count
    timestamp = time.strftime("%d-%m-%Y_%H-%M-%S")
    temp_filename = f"whisper_{timestamp}.tmp"  # Save as temporary file first
    final_filename = f"whisper_{timestamp}.wav"  # Final filename
    temp_file_path = os.path.join(os.path.abspath(save_dir), temp_filename)
    final_file_path = os.path.join(os.path.abspath(save_dir), final_filename)
    
    # Write to temporary file
    with concurrent.futures.ThreadPoolExecutor() as executor:
        future = executor.submit(write_wave_file, temp_file_path)

    # Wait until the file writing is complete
    future.result()  # This ensures that the writing process is complete

    # Rename the temp file to the final .wav file
    os.rename(temp_file_path, final_file_path)

    # Add the new whisper to the deque (new whispers)
    new_whispers.append(final_file_path)
    new_whispers_play_count = random.randint(5, 10)  # It will be played after 5-10 other whispers

    # Update past whispers length dynamically
    update_past_whispers_length(save_dir)

    print(f"Recording saved as {final_file_path}")
    return final_file_path


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

# Updated handle_recording_confirmation function to use the global control
def handle_recording_confirmation(file_path):
    global is_in_confirmation
    is_in_confirmation = True

    # Display "Checking audio file" while the transcription is being processed
    display_message_centered(checking_audio_text, checking_audio_color)

    # Wait for the transcription result (get transcription and classification)
    transcription, speech_type = transcribe_audio(file_path)

    if speech_type == "whisper":
        # If it's a whisper, thank the user and offer send options
        message = whisper_thank_you_text
        display_message_centered(message, whisper_thank_you_color)  # Green for whisper detected
        
        # Play the audio file back to the user once
        play_audio(file_path)

        # Now handle the spacebar logic for send or try again
        press_count = 0
        first_press_time = None
        waiting_for_decision = True

        while waiting_for_decision:
            for event in pygame.event.get():
                if event.type == pygame.KEYDOWN and event.key == pygame.K_SPACE:
                    # Record the first press time
                    if press_count == 0:
                        press_count += 1
                        first_press_time = time.time()  # Store the time of the first press

                    # If there's a second press within 1 second, consider it a double press
                    elif press_count == 1 and (time.time() - first_press_time) < 1:
                        press_count += 1
                        waiting_for_decision = False  # Exit loop after second press

            # After 1 second without a second press, treat it as a single press
            if press_count == 1 and (time.time() - first_press_time) >= 1:
                waiting_for_decision = False  # Exit loop to process single press

        # Process the decision after spacebar presses
        if press_count == 1:
            # Single press: Send the whisper (save it to the 'whispers' folder)
            whisper_folder = 'whispers'
            if not os.path.exists(whisper_folder):
                os.makedirs(whisper_folder)  # Create the folder if it doesn't exist
            
            save_recording(whisper_folder)  # Save the recording to the 'whispers' folder
            display_message_centered(whisper_sent_text, whisper_sent_color)

        elif press_count == 2:
            # Double press: Retry recording
            display_message_centered(retry_prompt_text, retry_prompt_color)
            # Reset for a new recording

    else:
        # If no whisper was detected, prompt the user to try again
        message = no_whisper_detected_text
        display_message_centered(message, no_whisper_color)  # Red for no whisper

    is_in_confirmation = False  # Mark confirmation as done




# Main loop and event handling
devices = list_audio_devices(p)
dropdown_open = False
selected_device_index = load_selected_device_index()
selected_device_index = min(selected_device_index, len(devices) - 1) if devices else 0
stream = None
is_recording = False
play_whispers_during_recording = False
is_in_confirmation = False
display_message_centered(initial_message_text, initial_message_color)  # Show initial message



# Function to play a random whisper from the 'whispers' folder at random intervals (1 to 5 seconds)
def play_random_whisper(whisper_folder):
    global new_whispers_play_count

    while True:
        if not is_in_confirmation or play_whispers_during_recording:
            # Get all whisper files in the folder (only .wav files, ignore .tmp files)
            whisper_files = [f for f in os.listdir(whisper_folder) if f.endswith(".wav")]

            if whisper_files:
                # Prioritize playing new whispers if they exist and the count has reached its limit
                if new_whispers and new_whispers_play_count <= 0:
                    random_whisper = new_whispers.popleft()  # Play the new whisper
                    new_whispers_play_count = random.randint(5, 10)  # Reset the counter
                else:
                    # Filter out past whispers from the random selection
                    available_whispers = [f for f in whisper_files if f not in past_whispers]

                    if not available_whispers:
                        available_whispers = whisper_files  # If all whispers have been recently played, reset

                    # Select a random whisper that hasn't been played in the last X times (dynamically sized queue)
                    random_whisper = random.choice(available_whispers)

                    # Add the played whisper to the past_whispers deque
                    past_whispers.append(random_whisper)

                    # If there are new whispers but not yet ready to play, decrease the counter
                    if new_whispers_play_count > 0:
                        new_whispers_play_count -= 1

                whisper_path = os.path.join(whisper_folder, random_whisper)

                # Play the random whisper file
                print(f"Playing random whisper: {random_whisper}")
                play_audio(whisper_path)  # Play the whisper audio

                # Wait for a random interval between 1 to 5 seconds
                random_interval = random.randint(1, 5)
                time.sleep(random_interval)
        else:
            # If we're in the confirmation loop and whispers shouldn't play, just wait
            time.sleep(1)  # Sleep briefly to avoid busy waiting

# Thread to continuously play random whispers
def start_random_whispers(whisper_folder):
    threading.Thread(target=play_random_whisper, args=(whisper_folder,), daemon=True).start()

# Example usage: Start random whispers (call this at the start of your script)
whisper_folder = "whispers"
update_past_whispers_length(whisper_folder)  # Initialize the past whispers queue size
start_random_whispers(whisper_folder)
running = True
while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False

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
            is_recording = True
            display_message_centered(whisper_prompt_text, whisper_prompt_color)  # Show "Whisper into the mic"
            stream = p.open(format=sample_format, channels=channels, rate=rate, input=True,
                            input_device_index=devices[selected_device_index]['index'], frames_per_buffer=chunk)
            frames = []

            while is_recording:
                data = stream.read(chunk, exception_on_overflow=False)
                frames.append(data)

                for stop_event in pygame.event.get():
                    if stop_event.type == pygame.KEYUP and stop_event.key == pygame.K_SPACE:
                        stream.stop_stream()
                        stream.close()
                        is_recording = False
                        recorded_file = save_recording(temp_dir)
                        handle_recording_confirmation(recorded_file)  # Handle transcription in the background
                        break
                    elif stop_event.type == pygame.QUIT:
                        running = False
                        is_recording = False
                        break

pygame.quit()
p.terminate()