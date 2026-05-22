import serial
import time
import string

# Configure the serial port (update 'COM3' with your correct port)
try:
    arduino_serial = serial.Serial('COM3', 115200, timeout=1)  # Adjust COM port as needed
    time.sleep(2)  # Allow some time for the serial connection to stabilize
    print("Connected to Arduino successfully.")
except serial.SerialException as e:
    print(f"Error opening serial port: {e}")
    exit()

def read_arduino_input():
    # This function checks if there's data waiting in the serial buffer
    if arduino_serial.in_waiting > 0:
        try:
            raw_data = arduino_serial.readline()
            # Filter out non-printable characters
            line = ''.join(chr(b) for b in raw_data if chr(b) in string.printable).strip()
            if line:
                print(f"Received from Arduino: {line}")  # Print everything received for debugging
            return line
        except Exception as e:
            print(f"Error reading from Arduino: {e}")
    return None

# Main loop for reading Arduino input
try:
    while True:
        arduino_event = read_arduino_input()
        if arduino_event == "BUTTON_PRESSED":
            print("Button Press Detected")
        elif arduino_event == "BUTTON_RELEASED":
            print("Button Release Detected")

        time.sleep(0.01)  # Add a small delay to avoid overwhelming the serial port
except KeyboardInterrupt:
    print("Program terminated manually.")
finally:
    if arduino_serial.is_open:
        arduino_serial.close()
    print("Serial connection closed.")
