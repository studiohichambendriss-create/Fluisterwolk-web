import os
from pytubefix import YouTube
from moviepy.editor import AudioFileClip
from pydub import AudioSegment
from pydub.silence import split_on_silence
from pydub.playback import play
import keyboard  # For detecting key presses
import shutil  # For moving processed files

# Directory setup
base_dir = "dataset"
whisper_dir = os.path.join(base_dir, "whisper")
normal_dir = os.path.join(base_dir, "normal")
processed_dir = "processed"  # Directory for processed files

# Ensure directories exist
os.makedirs(whisper_dir, exist_ok=True)
os.makedirs(normal_dir, exist_ok=True)
os.makedirs(processed_dir, exist_ok=True)  # Create 'processed' folder if it doesn't exist

def download_audio_from_youtube(youtube_url):
    """Downloads the first 1 minute of audio from a YouTube video."""
    yt = YouTube(youtube_url)
    stream = yt.streams.filter(only_audio=True, file_extension='mp4').first()
    if stream:
        output_file = stream.download(output_path=".", filename="youtube_audio.mp4")
        return output_file
    else:
        raise Exception("No valid audio stream found")

def extract_first_minute(input_file):
    """Extracts the first 1 minute of audio from the downloaded file."""
    audio_clip = AudioFileClip(input_file).subclip(0, 60)  # First 60 seconds
    output_file = "first_minute.wav"
    audio_clip.write_audiofile(output_file)
    return output_file

def get_next_file_name(folder, prefix, start_count):
    """Get the next available file name in the format prefix_X.wav where X is the next number."""
    next_index = start_count
    while True:
        file_path = os.path.join(folder, f"{prefix}_{next_index}.wav")
        if not os.path.exists(file_path):
            return file_path
        next_index += 1

# Function to normalize audio using pydub
def normalize_audio(audio_segment):
    return audio_segment.apply_gain(-audio_segment.max_dBFS)

def chop_by_intervals(audio, interval_ms=5000):
    """Chop audio into fixed intervals (e.g., every 5 seconds)."""
    chunks = []
    for i in range(0, len(audio), interval_ms):
        chunk = audio[i:i + interval_ms]
        chunks.append(chunk)
    return chunks

def chop_audio_by_words(input_file, silence_thresh=-50, min_silence_len=500, max_segment_length=2000):
    """Chop audio by silence and further split long sentences into smaller intervals."""
    # Load the audio file using pydub
    audio = AudioSegment.from_file(input_file)

    # Step 1: Split audio on silence
    word_segments = split_on_silence(
        audio,
        min_silence_len=min_silence_len,  # Minimum silence to detect a pause
        silence_thresh=silence_thresh,    # Silence threshold for quieter pauses
        keep_silence=100                  # Keep a bit of silence around the splits
    )

    # Step 2: Further split long segments into fixed-length intervals
    final_segments = []
    for segment in word_segments:
        if len(segment) > max_segment_length:
            final_segments.extend(chop_by_intervals(segment, interval_ms=max_segment_length))
        else:
            final_segments.append(segment)

    return final_segments

def process_audio_segments(segments, start_count, current_folder, file_prefix):
    auto_accept = False

    # Process each segment
    for i, word in enumerate(segments):
        normalized_word = normalize_audio(word)
        output_file = get_next_file_name(current_folder, file_prefix, start_count + i + 1)

        if auto_accept:
            normalized_word.export(output_file, format="wav")
            print(f"Auto-saved: {output_file}")
            continue

        print(f"Processing word {i + 1}/{len(segments)}. Current folder: {file_prefix}.")
        play(normalized_word)

        while True:
            if keyboard.is_pressed('x'):  # Discard the segment
                print(f"Discarded word {i + 1}")
                break
            elif keyboard.is_pressed('c'):  # Confirm the current segment
                normalized_word.export(output_file, format="wav")
                print(f"Saved: {output_file}")
                break
            elif keyboard.is_pressed('enter'):  # Auto-accept all remaining
                auto_accept = True
                normalized_word.export(output_file, format="wav")
                print(f"Auto-saved: {output_file}")
                break
            elif keyboard.is_pressed('1'):  # Toggle to whisper
                current_folder = whisper_dir
                file_prefix = "whisper"
                start_count = len([f for f in os.listdir(current_folder) if f.startswith(file_prefix)])
                print("Switched to saving as 'whisper'.")
                break
            elif keyboard.is_pressed('2'):  # Toggle to normal
                current_folder = normal_dir
                file_prefix = "normal"
                start_count = len([f for f in os.listdir(current_folder) if f.startswith(file_prefix)])
                print("Switched to saving as 'normal'.")
                break

def move_to_processed(input_file):
    """Move processed file to the 'processed' folder."""
    if not os.path.exists(processed_dir):
        os.makedirs(processed_dir)
    try:
        shutil.move(input_file, os.path.join(processed_dir, os.path.basename(input_file)))
        print(f"Moved '{input_file}' to '{processed_dir}'")
    except Exception as e:
        print(f"Error moving file: {e}")

def main():
    while True:
        youtube_url = input("Enter YouTube link to download and process (or 'q' to quit): ").strip()
        if youtube_url.lower() == 'q':
            print("Exiting...")
            break

        try:
            # Step 1: Download and extract first 1 minute of audio
            audio_file = download_audio_from_youtube(youtube_url)
            extracted_audio = extract_first_minute(audio_file)

            # Step 2: Process the audio
            segments = chop_audio_by_words(extracted_audio)
            process_audio_segments(segments, 0, whisper_dir, "whisper")

            # Move the downloaded file to processed folder
            move_to_processed(extracted_audio)

        except Exception as e:
            print(f"Error processing YouTube link: {e}")

if __name__ == "__main__":
    main()
