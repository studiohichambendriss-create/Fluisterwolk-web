import os
import random
import librosa
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, accuracy_score, confusion_matrix
import joblib  # For saving and loading the model
import sys
import matplotlib.pyplot as plt

# Define function to extract features from an audio file
def extract_features(audio_file, rate=44100):
    audio_data, _ = librosa.load(audio_file, sr=rate)
    
    # Normalize the audio data
    audio_data = audio_data / np.max(np.abs(audio_data) + 1e-10)
    
    # Calculate MFCCs
    mfccs = np.mean(librosa.feature.mfcc(y=audio_data, sr=rate, n_mfcc=13), axis=1)
    
    # Spectral centroid
    spectral_centroid = np.mean(librosa.feature.spectral_centroid(y=audio_data, sr=rate))
    
    # Zero-crossing rate
    zcr = np.mean(librosa.feature.zero_crossing_rate(y=audio_data))
    
    # Root Mean Square Energy (RMS)
    rms = np.sqrt(np.mean(audio_data ** 2))
    
    # Spectral slope (approximated as the difference between max and min frequencies)
    freqs = librosa.fft_frequencies(sr=rate, n_fft=1024)
    stft = np.abs(librosa.stft(audio_data, n_fft=1024, hop_length=512))
    mean_amplitude = np.mean(stft, axis=1)
    amplitude_db = 20 * np.log10(mean_amplitude + 1e-10)
    slope = np.polyfit(freqs, amplitude_db, 1)[0]  # First coefficient is the slope
    
    return np.hstack([mfccs, spectral_centroid, zcr, rms, slope])

# Load dataset from 'whisper' and 'normal' subfolders with progress percentage
def load_dataset(data_dir):
    labels = []
    features = []
    
    # Collect whisper files
    whisper_folder = os.path.join(data_dir, 'whisper')
    whisper_files = [os.path.join(whisper_folder, f) for f in os.listdir(whisper_folder) if f.endswith(('.wav', '.mp3'))]
    
    # Collect normal files
    normal_folder = os.path.join(data_dir, 'normal')
    normal_files = [os.path.join(normal_folder, f) for f in os.listdir(normal_folder) if f.endswith(('.wav', '.mp3'))]
    
    # Randomly select the same number of normal files as whisper files
    normal_sample_count = len(whisper_files)
    selected_normal_files = random.sample(normal_files, min(normal_sample_count, len(normal_files)))
    
    # Combine the files and labels
    all_files = whisper_files + selected_normal_files
    all_labels = [1]*len(whisper_files) + [0]*len(selected_normal_files)
    
    # Shuffle the files and labels together
    combined = list(zip(all_files, all_labels))
    random.shuffle(combined)
    all_files[:], all_labels[:] = zip(*combined)
    
    total_files = len(all_files)
    processed_files = 0

    def print_progress(file_path, progress):
        """Prints the static progress and the file being processed."""
        sys.stdout.write(f"\rProcessing: {os.path.basename(file_path)} | Progress: {progress:.2f}%")
        sys.stdout.flush()

    # Process all files
    for file_path, label in zip(all_files, all_labels):
        feature_vector = extract_features(file_path)
        features.append(feature_vector)
        labels.append(label)
        processed_files += 1
        progress = (processed_files / total_files) * 100
        print_progress(file_path, progress)
    
    print("\nFinished processing all files.")
    return np.array(features), np.array(labels)

# Main function to load dataset, train model, evaluate it, and save the model
def main():
    # Path to the dataset directory
    data_dir = 'dataset'  # Replace with the actual path to your dataset directory
    
    # After loading the dataset
    features, labels = load_dataset(data_dir)

    # Check the counts
    unique, counts = np.unique(labels, return_counts=True)
    print(f"Label distribution: {dict(zip(unique, counts))}")
    
    # Split dataset into training and testing sets with stratification
    X_train, X_test, y_train, y_test = train_test_split(
        features, labels, test_size=0.2, random_state=42, stratify=labels
    )
    
    # Initialize and train the Random Forest classifier
    clf = RandomForestClassifier(n_estimators=50, random_state=42)
    clf.fit(X_train, y_train)
    
    # Make predictions
    y_pred = clf.predict(X_test)
    
    # Evaluate the model
    print("\nClassification Report:\n", classification_report(y_test, y_pred))
    print("Accuracy: {:.2f}%".format(accuracy_score(y_test, y_pred) * 100))

    # Evaluate on training data
    y_train_pred = clf.predict(X_train)
    print("\nTraining Classification Report:\n", classification_report(y_train, y_train_pred))
    print("Training Accuracy: {:.2f}%".format(accuracy_score(y_train, y_train_pred) * 100))

    # Evaluate on test data
    y_test_pred = clf.predict(X_test)
    print("\nTest Classification Report:\n", classification_report(y_test, y_test_pred))
    print("Test Accuracy: {:.2f}%".format(accuracy_score(y_test, y_test_pred) * 100))

    # Confusion matrix on test data
    cm = confusion_matrix(y_test, y_test_pred)
    print("\nConfusion Matrix on Test Data:\n", cm)
    
    # Get predicted probabilities for the test set
    y_probs = clf.predict_proba(X_test)[:, 1]  # Probability of class '1' (whisper)

    # Print the predicted probabilities
    print("\nPredicted Probabilities for Class '1' (Whisper):\n", y_probs)

    # Plot histogram of predicted probabilities
    plt.hist(y_probs, bins=20, color='blue', alpha=0.7)
    plt.title('Histogram of Predicted Probabilities for Class 1 (Whisper)')
    plt.xlabel('Predicted Probability')
    plt.ylabel('Frequency')
    plt.show()
    # Save the trained model to a file
    joblib.dump(clf, 'whisper_vs_normal_model.pkl')
    print("Model saved as 'whisper_vs_normal_model.pkl'.")

if __name__ == '__main__':
    main()
