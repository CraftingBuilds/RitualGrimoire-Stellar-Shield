import os
from pathlib import Path

html_file = Path.home() / "Documents" / "RitualGrimoire-Stellar_Shield" / "web_ui" / "index.html"

print("🔍 Looking for:", html_file)

if html_file.exists():
    print("✅ Found it! Opening in Safari using 'open' command...")
    os.system(f"open '{html_file}'")
else:
    print("❌ index.html not found at:", html_file)