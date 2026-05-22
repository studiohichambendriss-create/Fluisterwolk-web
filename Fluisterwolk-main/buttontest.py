import pyaudio

# Initialize PyAudio
p = pyaudio.PyAudio()

# Print all available devices
print("Available Audio Devices:")
device_count = p.get_device_count()
for i in range(device_count):
    device_info = p.get_device_info_by_index(i)
    print(f"Index: {i}, Name: {device_info['name']}")

# Print default input device
default_input_info = p.get_default_input_device_info()
print("\nDefault Input Device:")
print(f"Index: {default_input_info['index']}, Name: {default_input_info['name']}")

# Print default output device
default_output_info = p.get_default_output_device_info()
print("\nDefault Output Device:")
print(f"Index: {default_output_info['index']}, Name: {default_output_info['name']}")

# Terminate PyAudio
p.terminate()
