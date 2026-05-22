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

# Initialize Pygame
pygame.init()

# Set up the display
width, height = 600, 400
screen = pygame.display.set_mode((width, height))
pygame.display.set_caption('Select Audio Device & Record')

font = pygame.font.SysFont(None, 30)

# Audio settings
chunk = 1024
sample_format = pyaudio.paInt16
channels = 1
rate = 44100
frames = []
filename = "recorded_audio.wav"
device_settings_file = "device_settings.json"
whisper_dir = "whispers"
temp_dir = "temp"

# Volume control settings
min_volume = 0.2  # Minimum volume threshold for silence detection (0 to 1)
max_volume = 0.9   # Maximum volume threshold for boosting the audio

# Option to pause random whispers during confirmation
pause_random_whispers_during_confirmation = True  # Set to False to continue playing whispers during confirmation
is_in_confirmation = False  # This will be set to True when in confirmation phase

# Create whispers and temp folders if they don't exist
if not os.path.exists(whisper_dir):
    os.makedirs(whisper_dir)
if not os.path.exists(temp_dir):
    os.makedirs(temp_dir)

# Initialize PyAudio
p = pyaudio.PyAudio()

# Function to list available recording devices
def list_audio_devices(p):
    device_count = p.get_device_count()
    input_devices = []
    for i in range(device_count):
        device_info = p.get_device_info_by_index(i)
        if device_info['maxInputChannels'] > 0:
            input_devices.append(device_info)
    return input_devices  # Return is now correctly indented outside the for loop

# Function to save selected device index to a file
def save_selected_device_index(index):
    with open(device_settings_file, "w") as f:
        json.dump({"selected_device_index": index}, f)

# Function to load selected device index from a file
def load_selected_device_index():
    if os.path.exists(device_settings_file):
        with open(device_settings_file, "r") as f:
            data = json.load(f)
            return data.get("selected_device_index", 0)
    return 0

# Function to display messages on screen
def display_message(message, color=(255, 255, 255)):
    screen.fill((0, 0, 0))  # Clear the screen
    text = font.render(message, True, color)
    screen.blit(text, (20, 150))  # Display message at a fixed position
    pygame.display.update()

# Function to normalize audio to a specific volume range
def normalize_audio(audio_data, target_volume):
    max_amplitude = np.max(np.abs(audio_data))
    if max_amplitude > 0:
        normalization_factor = target_volume / max_amplitude
        audio_data = audio_data * normalization_factor
    return np.clip(audio_data, -1, 1)

# Function to detect silence and crop the audio
def crop_silence(audio_data, rate, threshold):
    abs_audio = np.abs(audio_data)
    start = 0
    end = len(abs_audio) - 1

    # Find where sound starts
    for i in range(len(abs_audio)):
        if abs_audio[i] > threshold:
            start = i
            break

    # Find where sound ends
    for i in range(len(abs_audio) - 1, 0, -1):
        if abs_audio[i] > threshold:
            end = i
            break

    # Crop the audio to just the active part
    return audio_data[start:end]



# Function to save the recording to a specified directory
def save_recording(save_dir):
    # Create a timestamp for the filename
    timestamp = time.strftime("%d-%m-%Y_%H-%M-%S")
    unique_filename = f"whisper_{timestamp}.wav"

    # Save in the specified directory
    file_path = os.path.join(save_dir, unique_filename)

    wf = wave.open(file_path, 'wb')
    wf.setnchannels(channels)
    wf.setsampwidth(p.get_sample_size(sample_format))
    wf.setframerate(rate)
    wf.writeframes(b''.join(frames))
    wf.close()

    print(f"Recording saved as {file_path}")
    return file_path

# Function to play the recorded audio
def play_audio(filename):
    pygame.mixer.music.load(filename)
    pygame.mixer.music.play()
    while pygame.mixer.music.get_busy():
        pygame.time.Clock().tick(10)
    pygame.mixer.music.unload()  # Unload the music to free the file

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
    pygame.draw.polygon(screen, (255, 255, 255), [(dropdown_x + button_width - 20, dropdown_y + 15), (dropdown_x + button_width - 10, dropdown_y + 15), (dropdown_x + button_width - 15, dropdown_y + 25)])

    # If dropdown is open, display the list of devices
    if dropdown_open and devices:
        for index, device in enumerate(devices):
            device_y = dropdown_y + button_height + index * device_height
            pygame.draw.rect(screen, (50, 50, 50), (dropdown_x, device_y, button_width, device_height))
            device_text = font.render(f"{index + 1}: {device['name']}", True, (255, 255, 255))
            screen.blit(device_text, (dropdown_x + 10, device_y + 5))

# Function to draw the Accept, Cancel, and Replay buttons
def draw_buttons():
    # Positions and sizes
    button_width, button_height = 100, 50
    button_y = height - 100  # Position near the bottom
    spacing = 20

    # Calculate positions
    total_width = 3 * button_width + 2 * spacing
    start_x = (width - total_width) // 2

    accept_rect = pygame.Rect(start_x, button_y, button_width, button_height)
    cancel_rect = pygame.Rect(start_x + button_width + spacing, button_y, button_width, button_height)
    replay_rect = pygame.Rect(start_x + 2 * (button_width + spacing), button_y, button_width, button_height)

    # Draw buttons
    pygame.draw.rect(screen, (0, 200, 0), accept_rect)  # Green
    pygame.draw.rect(screen, (200, 0, 0), cancel_rect)  # Red
    pygame.draw.rect(screen, (0, 0, 200), replay_rect)  # Blue

    # Draw text
    accept_text = font.render("Accept", True, (255, 255, 255))
    cancel_text = font.render("Cancel", True, (255, 255, 255))
    replay_text = font.render("Replay", True, (255, 255, 255))

    screen.blit(accept_text, (accept_rect.x + (button_width - accept_text.get_width()) // 2, accept_rect.y + 10))
    screen.blit(cancel_text, (cancel_rect.x + (button_width - cancel_text.get_width()) // 2, cancel_rect.y + 10))
    screen.blit(replay_text, (replay_rect.x + (button_width - replay_text.get_width()) // 2, replay_rect.y + 10))

    pygame.display.update()

    return accept_rect, cancel_rect, replay_rect

def extract_most_prominent_section_with_control(
    audio_data, rate,
    energy_threshold_ratio=0.3,
    min_padding_duration=0.1,
    max_padding_duration=0.5
):
    frame_size = int(0.02 * rate)  # 20 milliseconds
    frame_shift = int(0.01 * rate)  # 10 milliseconds overlap

    # Normalize audio data
    audio_data = audio_data / np.max(np.abs(audio_data))

    # Calculate the number of frames
    num_frames = int((len(audio_data) - frame_size) / frame_shift) + 1

    energies = []

    # Compute energy for each frame
    for i in range(num_frames):
        start = i * frame_shift
        end = start + frame_size
        frame = audio_data[start:end]
        energy = np.sum(frame ** 2)
        energies.append(energy)

    energies = np.array(energies)

    # Smooth the energy curve (optional)
    window_size = 5
    energies_smoothed = np.convolve(energies, np.ones(window_size)/window_size, mode='same')

    # Find the index of the maximum energy
    max_energy = np.max(energies_smoothed)
    max_energy_index = np.argmax(energies_smoothed)

    # Define energy threshold
    threshold = energy_threshold_ratio * max_energy

    # Search for start frame
    start_frame = max_energy_index
    for i in range(max_energy_index, -1, -1):
        if energies_smoothed[i] < threshold:
            start_frame = i + 1
            break

    # Ensure minimum padding
    min_padding_frames = int(min_padding_duration / (frame_shift / rate))
    start_frame = max(0, start_frame - min_padding_frames)

    # Search for end frame
    end_frame = max_energy_index
    for i in range(max_energy_index, num_frames):
        if energies_smoothed[i] < threshold:
            end_frame = i - 1
            break

    # Ensure maximum padding
    max_padding_frames = int(max_padding_duration / (frame_shift / rate))
    end_frame = min(num_frames - 1, end_frame + max_padding_frames)

    # Convert frame indices back to sample indices
    start_sample = start_frame * frame_shift
    end_sample = end_frame * frame_shift + frame_size

    # Extract the audio segment
    extracted_audio = audio_data[start_sample:end_sample]

    return extracted_audio


# Function to handle cropping, normalizing, and confirmation
def handle_recording_confirmation(file_path):
    global is_in_confirmation
    is_in_confirmation = True

    # Read the audio data
    rate, audio_data = wavfile.read(file_path)
    audio_data = audio_data.astype(np.float32)

    # Extract the most prominent section with control
    extracted_audio = extract_most_prominent_section_with_control(
        audio_data, rate,
        energy_threshold_ratio=0.3,
        min_padding_duration=0.2,
        max_padding_duration=0.5
    )

    # Normalize the extracted audio
    normalized_audio = normalize_audio(extracted_audio, target_volume=max_volume)

    # Save the extracted and normalized audio back to the file
    wavfile.write(file_path, rate, (normalized_audio * 32767).astype(np.int16))
    print("Extracted the most prominent audio section with customized padding.")

    # Play back the audio
    display_message("Playing back the audio...", (0, 255, 0))
    play_audio(file_path)

    # Display menu options and handle user input
    user_decision = None
    while user_decision is None:
        # Display buttons
        display_message("Please select an option:")
        accept_rect, cancel_rect, replay_rect = draw_buttons()

        # Wait for events
        event = pygame.event.wait()
        if event.type == pygame.QUIT:
            pygame.quit()
            p.terminate()
            exit()
        elif event.type == pygame.MOUSEBUTTONDOWN:
            mouse_pos = event.pos
            if accept_rect.collidepoint(mouse_pos):
                # Move file to whispers directory
                whispers_file_path = os.path.join(whisper_dir, os.path.basename(file_path))
                # Ensure mixer is not using the file
                pygame.mixer.music.stop()
                pygame.mixer.music.unload()
                os.rename(file_path, whispers_file_path)
                print(f"Recording accepted and saved to {whispers_file_path}")
                user_decision = 'accept'
            elif cancel_rect.collidepoint(mouse_pos):
                # Delete the temporary file
                # Ensure mixer is not using the file
                pygame.mixer.music.stop()
                pygame.mixer.music.unload()
                os.remove(file_path)
                print("Recording discarded.")
                user_decision = 'cancel'
            elif replay_rect.collidepoint(mouse_pos):
                # Replay the audio
                display_message("Replaying the audio...", (0, 255, 0))
                play_audio(file_path)

    is_in_confirmation = False
def play_random_whispers():
    played_whispers_history = []
    while True:
        if pause_random_whispers_during_confirmation and is_in_confirmation:
            time.sleep(0.1)  # Wait a bit before checking again
            continue

        whispers = [f for f in os.listdir(whisper_dir) if f.endswith('.wav')]

        if whispers:
            # Determine history size based on number of whispers
            history_limit = max(1, min(len(whispers) - 1, len(whispers) // 2))
            # Exclude recently played whispers
            available_whispers = [w for w in whispers if w not in played_whispers_history]

            if not available_whispers:
                # If all whispers have been played recently, reset the history
                played_whispers_history = []
                available_whispers = whispers.copy()

            selected_whisper = random.choice(available_whispers)
            whisper_path = os.path.join(whisper_dir, selected_whisper)
            print(f"Playing random whisper: {selected_whisper}")
            play_audio(whisper_path)

            # Update the history
            played_whispers_history.append(selected_whisper)
            # Limit the history size
            if len(played_whispers_history) > history_limit:
                played_whispers_history.pop(0)

        time.sleep(random.uniform(0.5, 2))  # Random interval between 1 and 3 seconds


# Start a background thread to play random whispers
Thread(target=play_random_whispers, daemon=True).start()

# List audio devices
devices = list_audio_devices(p)

# Dropdown state
dropdown_open = False

# Load the last selected device, default to 0 if none
selected_device_index = load_selected_device_index()
if devices:
    selected_device_index = min(selected_device_index, len(devices) - 1)
else:
    selected_device_index = 0
stream = None
is_recording = False

running = True

while running:
    screen.fill((0, 0, 0))  # Clear the screen

    # Draw the dropdown menu
    draw_dropdown(devices, selected_device_index, dropdown_open)

    pygame.display.update()

    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False

        # Handle mouse clicks for dropdown
        elif event.type == pygame.MOUSEBUTTONDOWN:
            mouse_x, mouse_y = event.pos
            # Toggle dropdown when the button is clicked
            if 20 <= mouse_x <= 380 and 20 <= mouse_y <= 60:
                dropdown_open = not dropdown_open
            # Check if a device is selected from the dropdown
            if dropdown_open and devices:
                for index, device in enumerate(devices):
                    device_y = 60 + index * 40
                    if 20 <= mouse_x <= 380 and device_y <= mouse_y <= device_y + 40:
                        selected_device_index = index
                        dropdown_open = False  # Close dropdown after selection
                        save_selected_device_index(selected_device_index)  # Save the selected device index

        # Handle spacebar press to start and stop recording
        elif event.type == pygame.KEYDOWN and event.key == pygame.K_SPACE and not is_recording and devices:
            # Start recording
            print("Recording started...")
            display_message("Recording... Press Spacebar to stop", (255, 0, 0))
            stream = p.open(format=sample_format,
                            channels=channels,
                            rate=rate,
                            input=True,
                            input_device_index=devices[selected_device_index]['index'],
                            frames_per_buffer=chunk)
            is_recording = True
            frames = []  # Clear any previous frames

            # Keep recording until spacebar is released
            while is_recording:
                data = stream.read(chunk, exception_on_overflow=False)
                frames.append(data)

                # Check for KEYUP events to stop recording
                for confirm_event in pygame.event.get():
                    if confirm_event.type == pygame.KEYUP and confirm_event.key == pygame.K_SPACE:
                        # Stop recording
                        print("Recording stopped.")
                        stream.stop_stream()
                        stream.close()
                        is_recording = False

                        # Save the recording to temp directory
                        recorded_file = save_recording(temp_dir)

                        # Handle cropping, normalizing, and confirmation
                        handle_recording_confirmation(recorded_file)
                        break  # Exit the recording loop

                    elif confirm_event.type == pygame.QUIT:
                        running = False
                        is_recording = False
                        break  # Exit the recording loop

pygame.quit()
p.terminate()
