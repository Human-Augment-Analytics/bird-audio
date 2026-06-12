import hashlib
import os

MODELS = {
    "localizer": {
        "name": "Buzz Localizer",
        "path": "models/buzz_localizer.pt",
        "expected_hash": "edb569d74adfc996b36bbab8d846a0b03e2b10d76fc77a0feec01bd91a0e37de" 
    },
    "classifier": {
        "name": "Call Classifier",
        "path": "models/classifier.pt",
        "expected_hash": "0a9275d89dc9198e3241717a556d43d1c9de7667151f98943eb7ff23a01e9c8a"
    }
}

def calculate_sha256(filepath):
    sha256_hash = hashlib.sha256()
    try:
        with open(filepath, "rb") as f:
            for byte_block in iter(lambda: f.read(4096), b""):
                sha256_hash.update(byte_block)
        return sha256_hash.hexdigest()
    except FileNotFoundError:
        return None

def main():
    print("Verifying model integrity...\n")
    all_ok = True
    
    for key, info in MODELS.items():
        path = info["path"]
        name = info["name"]
        expected = info["expected_hash"]
        
        actual_hash = calculate_sha256(path)
        
        if actual_hash is None:
            print(f"[MISSING] {name} at {path}")
            all_ok = False
        elif actual_hash == expected:
            print(f"[OK]      {name}")
        else:
            print(f"[FAIL]    {name}")
            print(f"          Expected: {expected}")
            print(f"          Actual:   {actual_hash}")
            all_ok = False
            
    if all_ok:
        print("\nAll models verified.")
    else:
        print("\nSome models are missing or corrupted.")

if __name__ == "__main__":
    main()
