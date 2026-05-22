from PyQt6.QtWidgets import QApplication, QMainWindow, QPushButton, QLabel, QVBoxLayout, QWidget, QMessageBox
from PyQt6.QtCore import Qt, QTimer, QProcess, QMutex, pyqtSignal
import sys
import os
import psutil
import keyboard
import win32gui
import win32con
import win32api
import win32process
import subprocess
import time

class ProcessManager(QMainWindow):
    pause_requested = pyqtSignal()
    
    def __init__(self):
        super().__init__()
        # Remove admin check
        # Single instance check
        self.mutex = QMutex()
        if not self.mutex.tryLock():
            QMessageBox.critical(None, "Error", "Another instance is already running!")
            sys.exit(1)
            
        self.init_globals()
        self.init_ui()
        self.start_processes()
        self.pause_requested.connect(self.toggle_pause, Qt.ConnectionType.QueuedConnection)
        self.setup_global_hotkeys()
        self.setup_timers()

        # Add focus status timer
        self.status_timer = QTimer()
        self.status_timer.timeout.connect(self.log_focus_status)
        self.status_timer.start(2000)  # Every 2 seconds

        self.idle_timeout = 60  
        self.pause_start_time = None
        self.last_activity_time = time.time()
        
        # Add idle timer
        self.idle_timer = QTimer()
        self.idle_timer.timeout.connect(self.update_idle_display)
        self.idle_timer.start(1000)  # Update every second

        # Add activity tracking
        self.activity_timer = QTimer()
        self.activity_timer.timeout.connect(self.check_activity)
        self.activity_timer.start(1000)  # Check every second

    def init_globals(self):
        self.fluister_process = None
        self.web_process = None
        self.paused = False
        self.overlay = None
        self.base_dir = os.path.dirname(os.path.abspath(__file__))
        self.runfluister_path = os.path.join(self.base_dir, "runfluister.bat")
        self.runweb_path = os.path.join(self.base_dir, "runweb.bat")

    def setup_timers(self):
        self.focus_timer = QTimer()
        self.focus_timer.timeout.connect(self.check_processes)
        self.focus_timer.start(50)

    def init_ui(self):
        self.setWindowTitle("Fluisterwolk Manager")
        self.setGeometry(100, 100, 300, 150)
        layout = QVBoxLayout()
        
        self.status_label = QLabel("Status: Running")
        self.pause_btn = QPushButton("Pause Fluisterbox")
        self.pause_btn.clicked.connect(self.toggle_pause)
        
        layout.addWidget(self.status_label)
        layout.addWidget(self.pause_btn)
        
        container = QWidget()
        container.setLayout(layout)
        self.setCentralWidget(container)

    def start_processes(self):
        self.kill_existing_processes()
        
        # Start processes with visible consoles
        self.web_process = self.start_bat(self.runweb_path)
        self.fluister_process = self.start_bat(self.runfluister_path)

    def start_bat(self, path):
        process = QProcess()
        # Use native Windows API to create a new console window
        process = subprocess.Popen(
            ["cmd.exe", "/k", path],
            creationflags=subprocess.CREATE_NEW_CONSOLE
        )
        return process

    def check_processes(self):
        if not self.paused and self.fluister_process:
            try:
                # Check if process is still running
                if self.fluister_process.poll() is not None:
                    print("Fluisterbox stopped unexpectedly, restarting...")
                    self.fluister_process = self.start_bat(self.runfluister_path)
            except Exception as e:
                print(f"Process check error: {e}")
        
        self.enforce_focus()

    def enforce_focus(self):
        if not self.paused:
            try:
                hwnd = win32gui.FindWindow(None, "Fluisterbox")
                if hwnd:
                    # Force fullscreen
                    win32gui.SetWindowPos(
                        hwnd, win32con.HWND_TOPMOST,
                        0, 0, win32api.GetSystemMetrics(0), win32api.GetSystemMetrics(1),
                        win32con.SWP_SHOWWINDOW
                    )
                    
                    # Remove window chrome
                    win32gui.SetWindowLong(
                        hwnd, win32con.GWL_STYLE,
                        win32con.WS_VISIBLE | win32con.WS_POPUP
                    )
                    
                    # Aggressive focus stealing
                    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                    win32gui.SetForegroundWindow(hwnd)
                    win32gui.SetActiveWindow(hwnd)
                    win32gui.BringWindowToTop(hwnd)

            except Exception as e:
                print(f"Focus error: {str(e)}")

    def kill_existing_processes(self):
        current_pid = os.getpid()
        for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
            try:
                if proc.pid == current_pid:
                    continue
                if "fluiserbox" in ' '.join(proc.info['cmdline']).lower():
                    proc.kill()
            except Exception as e:
                print(f"Cleanup error: {str(e)}")

    def setup_global_hotkeys(self):
        def safe_pause():
            try:
                self.pause_requested.emit()
                print("Period key detected")
            except Exception as e:
                print(f"Hotkey error: {e}")
                QMessageBox.warning(self, "Hotkey Warning", 
                    "Could not register global hotkey. You can still use the pause button.")
        
        try:
            keyboard.add_hotkey('.', safe_pause, suppress=True)
        except Exception as e:
            print(f"Hotkey registration failed: {e}")
            QMessageBox.warning(self, "Hotkey Warning",
                "Global hotkeys might not work. You can still use the pause button.")

    def on_escape(self):
        if not self.paused:
            self.toggle_pause()

    def toggle_pause(self):
        try:
            self.paused = not self.paused
            print(f"\n=== PAUSE MODE CHANGE: {self.paused} ===")
            
            if self.paused:
                # Kill processes and show overlay
                self.kill_fluisterbox_processes()
                self.show_pause_overlay()
                
                # Open browser to web interface
                self.open_web_interface()
            else:
                # Restart Fluisterbox and hide overlay
                self.fluister_process = self.start_bat(self.runfluister_path)
                self.hide_pause_overlay()
                self.close_browser_windows()  # Close browser windows when unpausing
                
                # Close browser
                self.close_web_interface()
            
            self.update_ui()
            
        except Exception as e:
            print(f"Critical pause error: {e}")
            self.paused = False
            self.update_ui()

    def kill_fluisterbox_processes(self):
        try:
            if self.fluister_process and self.fluister_process.poll() is None:
                print(f"Killing main process PID: {self.fluister_process.pid}")
                parent = psutil.Process(self.fluister_process.pid)
                children = parent.children(recursive=True)
                
                print(f"Found {len(children)} child processes")
                for child in children:
                    print(f"Killing child PID: {child.pid}")
                    child.kill()
                
                print(f"Killing parent PID: {parent.pid}")
                parent.kill()
                gone, alive = psutil.wait_procs([parent] + children, timeout=3)
                
                print(f"Processes killed: {len(gone)}, Still alive: {len(alive)}")
                for p in alive:
                    print(f"Force killing stuck process PID: {p.pid}")
                    p.kill()
                
        except psutil.NoSuchProcess as e:
            print(f"Process already dead: {e}")
        except Exception as e:
            print(f"Kill error: {e}")

    def get_process_tree(self):
        try:
            if self.fluister_process:
                parent = psutil.Process(self.fluister_process.pid)
                return [p.pid for p in parent.children(recursive=True)] + [parent.pid]
            return []
        except:
            return []

    def get_process_state(self):
        if self.fluister_process:
            return "Running" if self.fluister_process.poll() is None else "Dead"
        return "Not running"

    def update_ui(self):
        state = "PAUSED" if self.paused else "RUNNING"
        self.status_label.setText(f"Status: {state}")
        self.pause_btn.setText("Resume" if self.paused else "Pause")
        print(f"UI updated to: {state}")

    def show_pause_overlay(self):
        if not self.overlay:
            self.overlay = QMainWindow()
            self.overlay.setWindowFlags(
                Qt.WindowType.WindowStaysOnTopHint |
                Qt.WindowType.FramelessWindowHint |
                Qt.WindowType.Tool
            )
            self.overlay.setStyleSheet("background-color: black;")
            
            # Get screen dimensions
            screen_geo = self.screen().availableGeometry()
            overlay_width = 300
            overlay_height = 150
            
            layout = QVBoxLayout()
            label = QLabel("PAUSE MODE\n\nPress . to resume")
            label.setStyleSheet("""
                font-size: 24px; 
                color: red; 
                font-weight: bold;
                background-color: black;
                padding: 20px;
            """)
            layout.addWidget(label)
            
            container = QWidget()
            container.setLayout(layout)
            self.overlay.setCentralWidget(container)
            
            # Position top-right
            self.overlay.setGeometry(
                screen_geo.width() - overlay_width,
                0,
                overlay_width,
                overlay_height
            )

        self.overlay.show()
        self.overlay.raise_()
        self.overlay.activateWindow()
        self.pause_start_time = time.time()

    def hide_pause_overlay(self):
        if self.overlay:
            self.overlay.hide()

    def log_focus_status(self):
        try:
            hwnd = win32gui.FindWindow(None, "Fluisterbox")
            if hwnd:
                # Verify window title
                actual_title = win32gui.GetWindowText(hwnd)
                if actual_title != "Fluisterbox":
                    print(f"[{time.strftime('%H:%M:%S')}] Window title mismatch! Actual: '{actual_title}'")
                
                fg_hwnd = win32gui.GetForegroundWindow()
                status = "FOCUSED" if fg_hwnd == hwnd else "NOT FOCUSED"
                print(f"[{time.strftime('%H:%M:%S')}] Fluisterbox focus status: {status}")
            else:
                print(f"[{time.strftime('%H:%M:%S')}] Fluisterbox window not found")
        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] Focus check error: {e}")

    def update_idle_display(self):
        if self.paused and self.overlay:
            current_time = time.time()
            idle_duration = current_time - self.last_activity_time
            time_until_restart = max(0, self.idle_timeout - idle_duration)
            
            # Print to console
            print(f"[{time.strftime('%H:%M:%S')}] Idle: {self.format_time(idle_duration)} | Restart in: {self.format_time(time_until_restart)}")
            
            # Update overlay with timer info
            self.overlay.findChild(QLabel).setText(
                f"PAUSE MODE\n\n"
                f"Idle: {self.format_time(idle_duration)}\n"
                f"Restart in: {self.format_time(time_until_restart)}\n\n"
                f"Press . to resume"
            )
            
            # Auto-restart if idle timeout reached
            if idle_duration >= self.idle_timeout:
                print("Idle timeout reached, resuming Fluisterbox")
                self.toggle_pause()

    def format_time(self, seconds):
        """Convert seconds to human-readable mm:ss format"""
        minutes = int(seconds // 60)
        seconds = int(seconds % 60)
        return f"{minutes:02d}:{seconds:02d}"

    def check_activity(self):
        try:
            # Get cursor position
            current_pos = win32gui.GetCursorPos()
            if hasattr(self, 'last_cursor_pos'):
                if current_pos != self.last_cursor_pos:
                    self.last_activity_time = time.time()
            self.last_cursor_pos = current_pos
        except Exception as e:
            print(f"Activity check error: {e}")

    def open_web_interface(self):
        try:
            # Get the IP address from WhisperWebviewer
            from WhisperWebviewer import get_local_ip
            ip = get_local_ip()
            url = f"http://{ip}:5000"
            
            # Open in default browser
            import webbrowser
            self.browser = webbrowser.get()
            self.browser.open_new(url)
            print(f"Opened web interface at {url}")
        except Exception as e:
            print(f"Error opening web interface: {e}")

    def close_web_interface(self):
        try:
            if hasattr(self, 'browser'):
                # Close browser window
                import os
                if os.name == 'nt':  # Windows
                    os.system('taskkill /im chrome.exe /f')  # Adjust for your browser
                else:  # macOS/Linux
                    os.system('pkill -f chrome')  # Adjust for your browser
                print("Closed web interface")
        except Exception as e:
            print(f"Error closing web interface: {e}")

    def close_browser_windows(self):
        """Close all browser windows (Chrome, Edge, etc.)"""
        try:
            os.system("taskkill /im chrome.exe /f")  # Close Chrome
            os.system("taskkill /im msedge.exe /f")  # Close Edge
            print("Closed all browser windows")
        except Exception as e:
            print(f"Error closing browser windows: {e}")

    def __del__(self):
        self.mutex.unlock()

if __name__ == "__main__":
    app = QApplication(sys.argv)
    manager = ProcessManager()
    manager.show()
    sys.exit(app.exec())
