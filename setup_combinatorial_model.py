#!/usr/bin/env python3
"""
setup script to create the CombinatorialExpert model
for Dr. Wong's research
"""

import subprocess
import sys
import os
import platform

def run_command(command, description):
    """Run a command and handle errors"""
    print(f"\n{description}...")
    try:
        result = subprocess.run(command, shell=True, check=True, capture_output=True, text=True)
        print(f"{description} completed successfully")
        if result.stdout:
            print(f"Output: {result.stdout.strip()}")
        return True
    except subprocess.CalledProcessError as e:
        print(f"{description} failed")
        if e.stderr:
            print(f"Error: {e.stderr.strip()}")
        return False

def main():
    print("Setting up CombinatorialExpert model for Dr. Wong's research")
    print("=" * 60)

    # Detect OS
    is_windows = os.name == "nt"
    grep_cmd = "findstr" if is_windows else "grep"

    # Check if Ollama is installed
    if not run_command("ollama --version", "Checking Ollama installation"):
        print("\nERROR: Ollama is not installed or not in PATH")
        print("Please install Ollama from: https://ollama.com/download")
        return False

    # Check if base model is available
    if not run_command(f"ollama list | {grep_cmd} llama3.2", "Checking if llama3.2 model is available"):
        print("\nERROR: Base model llama3.2 not found")
        print("Please run: ollama pull llama3.2")
        return False

    # Check if embedding model is available
    if not run_command(f"ollama list | {grep_cmd} nomic-embed-text", "Checking if nomic-embed-text model is available"):
        print("\nERROR: Embedding model nomic-embed-text not found")
        print("Please run: ollama pull nomic-embed-text")
        return False

    # Create the CombinatorialExpert model
    modelfile_path = "instance/knowledge/CombinatorialExpert_Modelfile"
    if not os.path.exists(modelfile_path):
        print(f"\nERROR: Modelfile not found at: {modelfile_path}")
        return False

    create_cmd = f"ollama create CombinatorialExpert -f {modelfile_path}"
    if not run_command(create_cmd, "Creating CombinatorialExpert model"):
        return False

    # Verify the model was created
    if not run_command(f"ollama list | {grep_cmd} CombinatorialExpert", "Verifying CombinatorialExpert model creation"):
        print("\nERROR: CombinatorialExpert model was not created successfully")
        return False

    print("\n" + "=" * 60)
    print("Setup completed successfully!")
    print("\nNext steps:")

    if is_windows:
        print("1. Activate your virtual environment: venv\\Scripts\\activate")
    else:
        print("1. Activate your virtual environment: source venv/bin/activate")

    print("2. Install dependencies: pip install -r requirements.txt")
    print("3. Start the backend: flask --app doe run --debug")
    print("\nThe CombinatorialExpert model is now ready to answer questions about Dr. Wong's combinatorial testing research!")

    return True

if __name__ == "__main__":
    success = main()
    if not success:
        sys.exit(1)
