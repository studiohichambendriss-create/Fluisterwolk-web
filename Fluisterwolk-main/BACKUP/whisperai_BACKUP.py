import pyaudio
import wave
import whisper
import keyboard
import numpy as np
import librosa
from better_profanity import profanity
import json
import os
# Initialize Whisper model and use GPU (CUDA)
model = whisper.load_model("tiny", device="cpu")
# File path for calibration
calibration_file = "calibration.json"

# Default calibration values
default_calibration = {
    "whisper_threshold_value": 0.006,  # Adjust based on experimentation
    "min_whisper_confidence_value": 5.0  # Minimum confidence for classifying as whisper
}

# Function to load calibration settings (without creating if the file doesn't exist)
def load_calibration():
    if os.path.exists(calibration_file):
        # File exists, load its values
        with open(calibration_file, 'r') as json_file:
            return json.load(json_file)
    else:
        # File doesn't exist, return default values
        return default_calibration

# Load the calibration settings
calibration_values = load_calibration()

# Assign the variables from the loaded JSON
whisper_threshold_value = calibration_values["whisper_threshold_value"]
min_whisper_confidence_value = calibration_values["min_whisper_confidence_value"]

CHUNK = 1024
FORMAT = pyaudio.paInt16
CHANNELS = 1
RATE = 44100
OUTPUT_FILENAME = "mic_input.wav"


def record_audio(filename):
    """Record audio from microphone while spacebar is pressed."""
    p = pyaudio.PyAudio()
    stream = p.open(format=FORMAT,
                    channels=CHANNELS,
                    rate=RATE,
                    input=True,
                    frames_per_buffer=CHUNK)

    print("Press and hold spacebar to start recording... (Press 'q' to quit)")

    frames = []

    # Wait for spacebar to be pressed
    while not keyboard.is_pressed('space'):
        if keyboard.is_pressed('q'):
            print("Exiting program.")
            stream.close()
            p.terminate()
            return False

    # Start recording when spacebar is held
    print("Recording... Release spacebar to stop.")
    while keyboard.is_pressed('space'):
        data = stream.read(CHUNK)
        frames.append(data)

    print("Finished recording.")

    # Stop and close the stream
    stream.stop_stream()
    stream.close()
    p.terminate()

    # Save the recorded audio to a .wav file
    wf = wave.open(filename, 'wb')
    wf.setnchannels(CHANNELS)
    wf.setsampwidth(p.get_sample_size(FORMAT))
    wf.setframerate(RATE)
    wf.writeframes(b''.join(frames))
    wf.close()

    return True

def calculate_rms(filename):
    """Calculate Root Mean Square (RMS) of the audio for volume analysis."""
    y, sr = librosa.load(filename, sr=RATE)
    rms = np.sqrt(np.mean(y**2))
    return rms

def transcribe_audio(filename, language=None):
    """Transcribe audio using Whisper and provide confidence of whisper vs. normal speech."""
    print("Transcribing audio...")

    # Specify the language (English: "en", Dutch: "nl") if provided
    if language:
        result = model.transcribe(filename, language=language)
    else:
        # Let Whisper auto-detect the language if no specific language is provided
        result = model.transcribe(filename)

    # Calculate RMS (volume level)
    rms = calculate_rms(filename)

    # Threshold for whisper detection (this can be fine-tuned based on your data)
    whisper_threshold = whisper_threshold_value
    min_whisper_confidence = min_whisper_confidence_value

    transcription_text = result["text"]
    print("Transcription result:")
    print(transcription_text)
    
    # Profanity check
    if profanity.contains_profanity(transcription_text):
        print("Warning: Profanity detected in transcription.")

    # Classify the speech as whisper or normal speech based on RMS
    if rms < whisper_threshold:
        confidence = 100 - (rms / whisper_threshold * 100)  # Lower RMS indicates higher likelihood of whisper
        if confidence > min_whisper_confidence:
            print(f"Detected speech likely to be a whisper. Confidence: {confidence:.2f}%")
            return transcription_text, "whisper", confidence  # Return transcription, classification, and confidence
        else:
            print(f"Confidence too low for whisper detection, treating as normal speech. Confidence: {confidence:.2f}%")
            return transcription_text, "normal speech", confidence  # Return "normal speech" classification with confidence
    else:
        confidence = rms / whisper_threshold * 100  # Higher RMS indicates normal speech
        print(f"Detected speech likely to be normal speech. Confidence: {confidence:.2f}%")
        return transcription_text, "normal speech", confidence  # Return "normal speech" classification with confidence



if __name__ == '__main__':
    while True:
        # Record audio from the microphone while holding spacebar
        if not record_audio(OUTPUT_FILENAME):
            break  # Exit the loop if 'q' is pressed

        # Transcribe the recorded audio using GPU and analyze for whisper/normal speech
        transcribe_audio(OUTPUT_FILENAME, language="en")

        print("\nReady for the next recording. Press spacebar to record or 'q' to quit.")
