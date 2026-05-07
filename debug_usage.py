import subprocess
import json
import re
import sys

def run_diagnostics():
    print("--- CodexBar Diagnostic Script ---")
    
    # 1. Get cookies using the existing importer
    print("\n1. Extracting cookies from browser...")
    try:
        res = subprocess.check_output(['python3', 'cookie_importer.py'], text=True)
        cookie_data = json.loads(res)
        if 'error' in cookie_data:
            print(f"Error: {cookie_data.get('error')}")
            print(f"Details: {cookie_data.get('details')}")
            return
        cookies = cookie_data['cookie_header']
        print("Successfully extracted cookies.")
    except Exception as e:
        print(f"Failed to run cookie_importer.py: {e}")
        return

    # 2. Get Access Token from ChatGPT session
    print("\n2. Fetching Access Token from ChatGPT...")
    headers = {
        'Accept': 'application/json',
        'Cookie': cookies,
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
    
    # Extract oai-did for the device header
    match = re.search(r'oai-did=([^;]+)', cookies)
    device_id = match.group(1) if match else None

    curl_session = [
        'curl', '-s', '-L',
        '-H', 'Accept: application/json',
        '-H', f'Cookie: {cookies}',
        '-H', f'User-Agent: {headers["User-Agent"]}',
    ]
    if device_id:
        curl_session += ['-H', f'oai-device-id: {device_id}']
    
    curl_session.append('https://chatgpt.com/api/auth/session')

    try:
        session_res = subprocess.check_output(curl_session, text=True)
        session_data = json.loads(session_res)
        if 'accessToken' not in session_data:
            print("Could not find accessToken in session response.")
            print(f"Response snippet: {session_res[:500]}")
            return
        token = session_data['accessToken']
        print("Successfully obtained Access Token.")
    except Exception as e:
        print(f"Failed to fetch session: {e}")
        return

    # 3. Fetch raw usage data
    print("\n3. Fetching raw usage data from backend-api...")
    curl_usage = [
        'curl', '-s',
        '-H', 'Accept: application/json',
        '-H', f'Authorization: Bearer {token}',
        '-H', f'User-Agent: {headers["User-Agent"]}',
        'https://chatgpt.com/backend-api/wham/usage'
    ]

    try:
        usage_res = subprocess.check_output(curl_usage, text=True)
        usage_json = json.loads(usage_res)
        
        print("\n--- RAW USAGE JSON START ---")
        # Anonymize email for privacy
        if 'email' in usage_json:
            usage_json['email'] = '***@***.***'
        print(json.dumps(usage_json, indent=2))
        print("--- RAW USAGE JSON END ---")
        
    except Exception as e:
        print(f"Failed to fetch usage: {e}")
        if 'usage_res' in locals():
            print(f"Raw response: {usage_res}")

if __name__ == "__main__":
    run_diagnostics()
