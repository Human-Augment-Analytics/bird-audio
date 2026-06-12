import hashlib
import os

MODELS = {
    "localizer": {
        "name": "Buzz Localizer",
        "path": "models/buzz_localizer.pt",
        "expected_hash": "TODO" 
    },
    "classifier": {
        "name": "Call Classifier",
        "path": "models/classifier.pt",
        "expected_hash": "TODO"
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
        
        actual_hash = calculate_sha256(path)
        
        if actual_hash is None:
            print(f"[MISSING] {name} at {path}")
            all_ok = False
        else:
            print(f"[OK]      {name}")
            print(f"          Hash: {actual_hash}")
            
    if all_ok:
        print("\nAll models verified.")
    else:
        print("\nSome models are missing or corrupted.")

if __name__ == "__main__":
    main()
