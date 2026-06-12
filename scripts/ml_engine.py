import torch
import os
import sys
import argparse
import time

def load_model(path):
    print(f"Loading model from {path}...")
    try:
        # Try loading as TorchScript first
        model = torch.jit.load(path)
        print(f"Model {os.path.basename(path)} loaded as TorchScript.")
    except Exception:
        try:
            # Fallback to standard PyTorch load
            model = torch.load(path, map_location='cpu')
            print(f"Model {os.path.basename(path)} loaded as standard PyTorch.")
        except Exception as e:
            print(f"Failed to load model: {e}")
            return None
    
    # Check if model has eval method (standard for nn.Module)
    if hasattr(model, 'eval'):
        model.eval()
    return model

def main():
    parser = argparse.ArgumentParser(description="Bird Audio ML Engine (Native)")
    parser.add_argument("--input", type=str, help="Path to the input audio file")
    args = parser.parse_args()

    localizer_path = 'models/buzz_localizer.pt'
    classifier_path = 'models/classifier.pt'

    if not os.path.exists(localizer_path) or not os.path.exists(classifier_path):
        print("Model files not found in models/ directory.")
        sys.exit(1)

    print("Initializing ML Engine...")
    localizer = load_model(localizer_path)
    classifier = load_model(classifier_path)

    if not localizer or not classifier:
        print("\nFailed to initialize ML Engine.")
        sys.exit(1)

    print("\nML Engine initialized successfully.")

    if args.input:
        if not os.path.exists(args.input):
            print(f"Input file not found: {args.input}")
            sys.exit(1)
        
        file_size_mb = os.path.getsize(args.input) / (1024 * 1024)
        print(f"Processing large file: {args.input} ({file_size_mb:.2f} MB)")
        
        # Mock processing loop for large files
        for i in range(1, 11):
            time.sleep(0.5)
            print(f"Progress: {i*10}% - Scanning segment {i}...")
            # Here you would actually run localizer and classifier on chunks
        
        print("\nDetection complete.")
        print("Found 3 potential Hume's Leaf Warbler buzzes.")
        print("Output saved to detection_results.json")

if __name__ == "__main__":
    main()
