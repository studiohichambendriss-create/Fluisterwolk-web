import sys
from PyQt6.QtWidgets import QApplication, QMainWindow, QLabel, QWidget
from PyQt6.QtCore import Qt, QTimer, QThread, pyqtSignal
from PyQt6.QtGui import QColor, QPainter, QFont
import keyboard
import time
import os

# [Keep all your existing imports and non-UI code from fluiserbox2.0.py here]
# [Include all your audio, serial, and whisper processing code]

class OverlayWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowFlags(Qt.WindowType.FramelessWindowHint | 
                           Qt.WindowType.WindowStaysOnTopHint |
                           Qt.WindowType.Tool)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setGeometry(100, 100, 400, 200)  # Top-right position
        
        self.label = QLabel(self)
        self.label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.label.setStyleSheet("color: white; font-size: 24px;")
        self.update_pause_display()

    def update_pause_display(self):
        if is_paused:
            self.label.setText("PAUSE MODE\nPress . to unpause")
            self.label.setStyleSheet("color: red; font-size: 24px; font-weight: bold;")
        else:
            self.label.setText("")
        self.label.resize(400, 200)

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowState(Qt.WindowState.WindowFullScreen)
        self.setCursor(Qt.CursorShape.BlankCursor)
        
        self.overlay = OverlayWindow()
        self.overlay.show()
        
        self.main_label = QLabel(self)
        self.main_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.update_main_display()
        
        # Setup timers
        self.timer = QTimer()
        self.timer.timeout.connect(self.check_activity)
        self.timer.start(1000)
        
        # Global hotkey setup
        keyboard.add_hotkey('.', self.toggle_pause)

    def update_main_display(self):
        if is_paused:
            return
        if is_in_confirmation or is_recording:
            # Handle special states
            pass
        else:
            self.main_label.setText(initial_message_text)
            self.main_label.setStyleSheet(f"color: rgb{initial_message_color}; font-size: 48px;")
            self.main_label.resize(self.size())

    def check_activity(self):
        if is_paused and (time.time() - last_activity_time) > PAUSE_MODE_TIMEOUT:
            self.toggle_pause()

    def toggle_pause(self):
        global is_paused
        is_paused = not is_paused
        
        if is_paused:
            self.setWindowState(Qt.WindowState.WindowNoState)
            self.overlay.show()
        else:
            self.setWindowState(Qt.WindowState.WindowFullScreen)
            self.overlay.hide()
        
        self.overlay.update_pause_display()
        self.update_main_display()

class AudioThread(QThread):
    update_signal = pyqtSignal(str)
    
    def run(self):
        # [Move your audio playback loop here]
        pass

if __name__ == "__main__":
    app = QApplication(sys.argv)
    main_window = MainWindow()
    main_window.showFullScreen()
    
    # Start background threads
    audio_thread = AudioThread()
    audio_thread.start()
    
    # [Start your existing whisper playback thread]
    
    sys.exit(app.exec()) 