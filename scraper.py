
from dotenv import load_dotenv
import requests
from bs4 import BeautifulSoup
from PIL import Image, ImageOps
from io import BytesIO
import pytesseract
# pytesseract.pytesseract.tesseract_cmd = r'C:/Program Files/Tesseract-OCR/tesseract.exe'
import google.generativeai as genai

import json
import logging
from urllib.parse import urljoin
# import pyperclip  # Optional, for clipboard copy
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import time
import base64
from datetime import datetime
import os

if os.name != 'nt':  # Not Windows
    pytesseract.pytesseract.tesseract_cmd = 'tesseract'

# -- Setup logging --
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')

load_dotenv()

api_key = os.getenv("GEMINI_API_KEY")
# Initialize Gemini
genai.configure(api_key=api_key)
model = genai.GenerativeModel("gemini-1.5-flash")


# 2captcha configuration
CAPTCHA_API_KEY = "e0789a56011da02cbd3968ef6f0b227b" # Not working
CAPTCHA_ENDPOINT = f"https://api.2captcha.com/proxy?key={CAPTCHA_API_KEY}"

class CaptchaSolver:
    def __init__(self, api_key):
        self.api_key = api_key
        self.base_url = "http://2captcha.com"
    
    def solve_image_captcha(self, image_base64):
        """
        Solve image CAPTCHA using 2captcha service
        """
        try:
            # Submit CAPTCHA for solving
            submit_url = f"{self.base_url}/in.php"
            submit_data = {
                'key': self.api_key,
                'method': 'base64',
                'body': image_base64,
                'json': 1
            }
            
            print("🔄 Submitting CAPTCHA to 2captcha service...")
            submit_response = requests.post(submit_url, data=submit_data, timeout=7)
            submit_result = submit_response.json()
            
            if submit_result.get('status') != 1:
                raise Exception(f"Failed to submit CAPTCHA: {submit_result.get('error_text', 'Unknown error')}")
            
            captcha_id = submit_result.get('request')
            print(f"✓ CAPTCHA submitted successfully. ID: {captcha_id}")
            
            # Poll for solution
            result_url = f"{self.base_url}/res.php"
            max_attempts = 20  # Wait up to 5 minutes
            
            for attempt in range(max_attempts):
                print(f"⏰ Waiting for CAPTCHA solution... (Attempt {attempt + 1}/{max_attempts})")
                time.sleep(1)  # Wait 2 seconds between checks
                
                result_params = {
                    'key': self.api_key,
                    'action': 'get',
                    'id': captcha_id,
                    'json': 1
                }
                
                result_response = requests.get(result_url, params=result_params, timeout=8)
                result_data = result_response.json()
                
                if result_data.get('status') == 1:
                    solution = result_data.get('request')
                    print(f"✅ CAPTCHA solved successfully: {solution}")
                    return solution
                elif result_data.get('error_text') == 'CAPCHA_NOT_READY':
                    continue
                else:
                    raise Exception(f"CAPTCHA solving failed: {result_data.get('error_text', 'Unknown error')}")
            
            raise Exception("CAPTCHA solving timed out")
            
        except Exception as e:
            print(f"❌ Error solving CAPTCHA: {e}")
            return None
    
    def get_image_base64_from_element(self, driver, image_element):
        """
        Extract base64 image data from image element
        """
        try:
            # Get the src attribute
            src = image_element.get_attribute('src')
            
            if src and src.startswith('data:image'):
                # Extract base64 data from data URL
                base64_data = src.split(',')[1]
                return base64_data
            else:
                # If it's a regular URL, download the image
                img_url = src
                if not img_url.startswith('http'):
                    img_url = driver.current_url.split('/')[0] + '//' + driver.current_url.split('/')[2] + src
                
                response = requests.get(img_url, timeout=10)
                image_data = base64.b64encode(response.content).decode('utf-8')
                return image_data
                
        except Exception as e:
            print(f"Error extracting image data: {e}")
            return None

def check_captcha_filled(driver, captcha_input):
    """
    Check if CAPTCHA input field has been filled by user
    """
    try:
        current_value = captcha_input.get_attribute('value')
        return current_value and len(current_value.strip()) > 0
    except:
        return False

def wait_for_manual_captcha(driver, captcha_input, max_wait_time=10):
    """
    Wait for user to manually fill CAPTCHA with timeout
    """
    print(f"⏰ Waiting for manual CAPTCHA entry (max {max_wait_time} seconds)...")
    print("👤 Please fill the CAPTCHA manually...")
    
    start_time = time.time()
    
    while time.time() - start_time < max_wait_time:
        if check_captcha_filled(driver, captcha_input):
            print("✅ CAPTCHA has been filled manually!")
            return True
        
        remaining_time = max_wait_time - int(time.time() - start_time)
        if remaining_time % 10 == 0:  # Print every 10 seconds
            print(f"⏰ Waiting for CAPTCHA... ({remaining_time}s remaining)")
        
        time.sleep(1)
    
    print("⏰ Timeout reached for manual CAPTCHA entry")
    return False

def extract_table_data(driver):
    """
    Extract data from the search results table
    """
    print("📊 Extracting table data from search results...")
    
    try:
        # Wait for table to be present
        table = WebDriverWait(driver, 8).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, "table.responsive-table, table#data-table-simple, table.dataTable"))
        )
        
        # Find all table rows in tbody
        rows = table.find_elements(By.CSS_SELECTOR, "tbody tr")
        
        extracted_records = []
        
        for i, row in enumerate(rows, 1):
            try:
                # Extract table data - adjust selectors based on the actual table structure
                cells = row.find_elements(By.TAG_NAME, "td")
                
                if len(cells) >= 6:  # Make sure we have enough columns
                    record = {
                        "sno": cells[0].text.strip() if len(cells) > 0 else "",
                        "company_name": cells[1].text.strip() if len(cells) > 1 else "",
                        "premises_address": cells[2].text.strip() if len(cells) > 2 else "",
                        "license_number": cells[3].text.strip() if len(cells) > 3 else "",
                        "license_type": cells[4].text.strip() if len(cells) > 4 else "",
                        "status": cells[5].text.strip() if len(cells) > 5 else "",
                        "view_products_available": "View Products" in row.text
                    }
                    
                    # Clean up the data
                    record["company_name"] = record["company_name"].replace("\n", " ").strip()
                    record["premises_address"] = record["premises_address"].replace("\n", " ").strip()
                    
                    extracted_records.append(record)
                    
                    print(f"✅ Extracted record {i}: {record['company_name']} - {record['license_number']}")
                
            except Exception as e:
                print(f"❌ Error extracting row {i}: {e}")
                continue
        
        print(f"✅ Successfully extracted {len(extracted_records)} records from table")
        return extracted_records
        
    except Exception as e:
        print(f"❌ Error extracting table data: {e}")
        return []

def extract_product_details_with_llm(page_content):
    """
    Extract product details from the page content using LLM
    """
    prompt = (
        "Extract all available product/license details from the following content. "
        "Return ONLY a valid JSON object with all the information you can find. "
        "Include fields like: company_name, license_number, license_type, status, "
        "validity, address, products, manufacturing_details, etc. "
        "If data is missing, use null. "
        "\nContent:\n" + page_content
    )
    
    try:
        response = model.generate_content(prompt)
        response_text = response.text.strip()
        
        json_start = response_text.find('{')
        json_end = response_text.rfind('}') + 1
        
        if json_start >= 0 and json_end > 0:
            json_str = response_text[json_start:json_end]
            try:
                data = json.loads(json_str)
                return data
            except json.JSONDecodeError as e:
                logging.error(f"JSON parsing error: {e}")
                return {"error": "JSON parsing failed", "raw_content": page_content[:1000]}
        else:
            return {"error": "No JSON found in response", "raw_content": page_content[:1000]}
    except Exception as e:
        return {"error": f"LLM extraction failed: {e}", "raw_content": page_content[:1000]}

def save_results_to_file(data, filename=None):
    """
    Save extracted data to JSON file
    """
    if filename is None:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"foscos_results_{timestamp}.json"
    
    try:
        # Create results directory if it doesn't exist
        os.makedirs("results", exist_ok=True)
        filepath = os.path.join("results", filename)
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
        
        print(f"✅ Results saved to: {filepath}")
        return filepath
    except Exception as e:
        print(f"❌ Error saving results: {e}")
        return None

def preprocess_image(image: Image.Image) -> Image.Image:
    try:
        image = ImageOps.grayscale(image)
        image = image.resize((image.width * 2, image.height * 2))
        return image
    except Exception as e:
        logging.warning(f"Image preprocessing failed: {e}")
        return image

def scrape_text_and_images(url: str) -> str:
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
    except Exception as e:
        logging.error(f"Error fetching page {url}: {e}")
        return ""
    soup = BeautifulSoup(response.text, "html.parser")
    full_text = " ".join(tag.get_text(" ", strip=True) for tag in soup.find_all())
    images = soup.find_all("img")
    for img in images:
        img_url = img.get("src")
        if not img_url:
            continue
        img_url = urljoin(url, img_url)
        try:
            img_response = requests.get(img_url, timeout=10)
            if "image" not in img_response.headers.get("Content-Type", ""):
                continue
            image = Image.open(BytesIO(img_response.content))
            image = preprocess_image(image)
            text = pytesseract.image_to_string(image)
            logging.info(f"OCR from image at {img_url} extracted text length: {len(text.strip())}")
            full_text += " " + text
        except Exception as e:
            logging.warning(f"Skipping image {img_url}: {e}")
            continue
    return full_text

def extract_license_with_llm(url: str, max_retries: int = 2) -> dict:
    combined_text = scrape_text_and_images(url)
    prompt = (
        "Extract the following fields from the given scraped website content. "
        "Return ONLY a valid JSON object (no explanation, no text outside JSON). "
        "If data is missing, use null or empty string. "
        "Fields:\n"
        "- license_number (manufacturer Lic. No. / FSSAI Lic. No.)\n"
        "- shelf_life (e.g. 'Best before 12 months from MFG')\n"
        "- expiry_date (if mentioned)\n"
        "- manufacturer_name (if available)\n"
        "\nText:\n" +
        combined_text
    )
    for attempt in range(max_retries):
        response = model.generate_content(prompt)
        response_text = response.text.strip()
        json_start = response_text.find('{')
        json_end = response_text.rfind('}') + 1
        if json_start >= 0 and json_end > 0:
            json_str = response_text[json_start:json_end]
            try:
                data = json.loads(json_str)
                return data
            except json.JSONDecodeError as e:
                logging.error(f"JSON parsing error: {e}")
        else:
            logging.warning("No JSON object found from Gemini response.")
    return {"error": "Failed to get valid JSON from Gemini", "raw_response": response_text}

def automate_foscos_form(license_number: str):
    options = webdriver.ChromeOptions()
    options.add_argument("--start-maximized")
    options.add_argument("--headless")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1920,1080")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option('useAutomationExtension', False)

    options.binary_location = "/usr/bin/chromium"
    
    driver = webdriver.Chrome(options=options)
    captcha_solver = CaptchaSolver(CAPTCHA_API_KEY)
    wait = WebDriverWait(driver, 9)
    
    # Initialize result structure
    foscos_data = {
        "license_search_results": [],
        "product_details": None,
        "search_successful": False,
        "products_extracted": False
    }

    try:
        # Navigate to the main FoSCoS website
        driver.get("https://foscos.fssai.gov.in")
        
        print("Navigating to FoSCoS website...")
        time.sleep(3)  # Allow page to load completely
        
        # Click on "FBO Search" tab in the navigation menu
        print("Looking for FBO Search tab...")
        fbo_search_tab = None
        
        # Try to find the specific FBO Search tab with exact attributes
        fbo_search_selectors = [
            "//a[@id='governmentAgencies1']",
            "//a[@href='#governmentAgenciesDiv1']",
            "//a[contains(@id, 'governmentAgencies1') and contains(text(), 'FBO Search')]",
            "//a[@data-toggle='tab' and @href='#governmentAgenciesDiv1']",
            "//a[contains(@href, 'governmentAgenciesDiv1')]",
            "//a[.//b[text()='FBO Search']]",
            "//b[text()='FBO Search']/parent::a"
        ]
        
        for selector in fbo_search_selectors:
            try:
                fbo_search_tab = driver.find_element(By.XPATH, selector)
                if fbo_search_tab.is_displayed() and fbo_search_tab.is_enabled():
                    print(f"Found FBO Search tab with selector: {selector}")
                    break
            except:
                continue
        
        if fbo_search_tab:
            # Click the FBO Search tab to open the form
            driver.execute_script("arguments[0].click();", fbo_search_tab)
            print("Clicked on FBO Search tab")
            time.sleep(3)
        else:
            print("FBO Search tab not found. Proceeding to look for form directly...")
        
        # Look for the License/Registration Certificate No. input field
        print("Looking for license input field...")
        license_input = None
        
        # Based on your image, the placeholder text is "License/Registration No."
        license_input_selectors = [
            "//input[@placeholder='License/Registration No.']",
            "//input[contains(@placeholder, 'License/Registration')]",
            "//input[contains(@placeholder, 'License')]",
            "//input[@name='licenseNo']",
            "//input[@id='licenseNo']",
            "(//input[@type='text'])[2]",  # Second text input based on form structure
            "//input[contains(@class, 'form-control')]"
        ]
        
        for selector in license_input_selectors:
            try:
                license_input = wait.until(EC.element_to_be_clickable((By.XPATH, selector)))
                print(f"Found license input field with selector: {selector}")
                break
            except:
                continue
        
        if license_input:
            # Clear and enter the license number
            license_input.clear()
            time.sleep(1)
            license_input.send_keys(license_number)
            print(f"✓ Entered license number: {license_number}")
            
            # Scroll to the license input to ensure it's visible
            driver.execute_script("arguments[0].scrollIntoView(true);", license_input)
            time.sleep(1)
        else:
            print("❌ License input field not found!")
            return foscos_data
        
        # Find CAPTCHA elements
        print("Looking for CAPTCHA image...")
        captcha_image = None
        captcha_input = None
        
        # Find CAPTCHA image
        captcha_image_selectors = [
            "//img[@alt='Captcha']",
            "//img[contains(@src, 'data:image')]",
            "//img[contains(@alt, 'captcha')]",
            "//img[contains(@alt, 'Captcha')]"
        ]
        
        for selector in captcha_image_selectors:
            try:
                captcha_image = driver.find_element(By.XPATH, selector)
                if captcha_image.is_displayed():
                    print(f"Found CAPTCHA image with selector: {selector}")
                    break
            except:
                continue
        
        # Find CAPTCHA input field
        captcha_input_selectors = [
            "//input[@placeholder='Enter Captcha Code']",
            "//input[@formcontrolname='captcha']",
            "//input[@id='govAgenciesSearch'][@type='text']",
            "//input[contains(@placeholder, 'Captcha')]"
        ]
        
        for selector in captcha_input_selectors:
            try:
                captcha_input = driver.find_element(By.XPATH, selector)
                if captcha_input.is_displayed():
                    print(f"Found CAPTCHA input field with selector: {selector}")
                    break
            except:
                continue
        
        captcha_solved = False
        
        if captcha_image and captcha_input:
            # First try automatic CAPTCHA solving
            print("🔄 Attempting automatic CAPTCHA solving...")
            
            # Get image data
            image_base64 = captcha_solver.get_image_base64_from_element(driver, captcha_image)
            
            if image_base64:
                # Solve CAPTCHA
                captcha_solution = captcha_solver.solve_image_captcha(image_base64)
                
                if captcha_solution:
                    # Enter CAPTCHA solution
                    captcha_input.clear()
                    time.sleep(1)
                    captcha_input.send_keys(captcha_solution)
                    print(f"✅ CAPTCHA solution entered automatically: {captcha_solution}")
                    captcha_solved = True
                    time.sleep(1)
                else:
                    print("❌ Automatic CAPTCHA solving failed")
            
            # If automatic solving failed, wait for manual input
            if not captcha_solved:
                print("\n" + "="*60)
                print("🔧 AUTOMATIC CAPTCHA SOLVING FAILED")
                print("👤 PLEASE SOLVE THE CAPTCHA MANUALLY")
                print("="*60)
                
                # Wait for user to manually fill CAPTCHA
                captcha_filled = wait_for_manual_captcha(driver, captcha_input, max_wait_time=20)
                
                if captcha_filled:
                    print("✅ Manual CAPTCHA entry detected!")
                    captcha_solved = True
                    # Wait 3 seconds after user fills CAPTCHA
                    print("⏰ Waiting 3 seconds before submitting...")
                    time.sleep(3)
                else:
                    # If no manual input, still try to submit
                    print("⚠️ No manual CAPTCHA input detected, proceeding anyway...")
        else:
            print("❌ CAPTCHA elements not found!")
        
        # Look for search/submit button
        print("Looking for search button...")
        search_button = None
        
        search_button_selectors = [
            "//button[@id='govAgenciesSearch'][@type='button']",
            "//button[contains(text(), 'Search')]",
            "//button[contains(@class, 'btn-default') and contains(text(), 'Search')]",
            "//input[@type='submit']", 
            "//button[@type='submit']",
            "//input[@value='Search']",
            "//button[contains(@class, 'btn') and contains(text(), 'Search')]"
        ]
        
        for selector in search_button_selectors:
            try:
                search_button = driver.find_element(By.XPATH, selector)
                if search_button.is_displayed() and search_button.is_enabled():
                    print(f"Found search button with selector: {selector}")
                    break
            except:
                continue
        
        if search_button:
            # Scroll to button and click
            driver.execute_script("arguments[0].scrollIntoView(true);", search_button)
            time.sleep(2)
            driver.execute_script("arguments[0].click();", search_button)
            print("✅ Clicked search button")
            time.sleep(1)
        else:
            print("❌ Search button not found!")
            print("Please click the search button manually.")
            time.sleep(3)
        
        # Extract table data first
        print("📊 Extracting search results table data...")
        table_data = extract_table_data(driver)
        foscos_data["license_search_results"] = table_data
        foscos_data["search_successful"] = len(table_data) > 0
        
        if table_data:
            print(f"✅ Found {len(table_data)} license records in search results")
            for record in table_data:
                print(f"  - {record['company_name']} | {record['license_number']} | {record['status']}")
        else:
            print("❌ No license data found in search results")
        
        # Wait for results and look for "View Products" button
        print("Looking for 'View Products' button...")
        
        view_products_button = None
        view_products_selectors = [
            "//a[contains(text(), 'View Products')]",
            "//a[contains(@style, 'cursor: pointer') and contains(@style, 'color: blue')]",
            "//a[@_ngcontent-c4=''][contains(@style, 'cursor: pointer')]",
            "//a[contains(@style, 'color: blue')]",
            "//*[contains(text(), 'View Products')]"
        ]
        
        # Wait up to 15 seconds for View Products button (reduced time since we already have table data)
        max_wait = 15
        found_button = False
        
        for i in range(max_wait):
            for selector in view_products_selectors:
                try:
                    view_products_button = driver.find_element(By.XPATH, selector)
                    if view_products_button.is_displayed():
                        print(f"✅ Found 'View Products' button with selector: {selector}")
                        found_button = True
                        break
                except:
                    continue
            
            if found_button:
                break
                
            print(f"⏰ Looking for 'View Products' button... ({i+1}/{max_wait})")
            time.sleep(1)
        
        if view_products_button and found_button:
            print("🔄 Clicking 'View Products' button...")
            
            # Scroll to button and click
            driver.execute_script("arguments[0].scrollIntoView(true);", view_products_button)
            time.sleep(1)
            driver.execute_script("arguments[0].click();", view_products_button)
            print("✅ Clicked 'View Products' button")
            
            # Wait for product details page to load
            time.sleep(1)
            
            # Extract all page content
            print("📊 Extracting product details...")
            page_content = driver.page_source
            
            # Use LLM to extract structured data
            extracted_data = extract_product_details_with_llm(page_content)
            foscos_data["product_details"] = extracted_data
            foscos_data["products_extracted"] = True
            
            print("✅ Product details extracted successfully!")
            
        else:
            print("❌ 'View Products' button not found!")
            print("Will return search results data only")
            
            # Take screenshot for debugging
            try:
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                screenshot_path = f"debug_screenshot_{timestamp}.png"
                driver.save_screenshot(screenshot_path)
                print(f"📸 Screenshot saved: {screenshot_path}")
            except:
                print("Could not save screenshot")
        
        # Create final data structure
        final_data = {
            "extraction_timestamp": datetime.now().isoformat(),
            "source_license_number": license_number,
            "search_results": foscos_data["license_search_results"],
            "product_details": foscos_data["product_details"],
            "summary": {
                "search_successful": foscos_data["search_successful"],
                "products_extracted": foscos_data["products_extracted"],
                "total_records_found": len(foscos_data["license_search_results"])
            },
            "page_url": driver.current_url
        }
        
        # Save results to file
        save_results_to_file(final_data)
        
        print("\n" + "="*50)
        print("✅ PROCESS COMPLETED")
        print("="*50)
        print(f"📊 Found {len(table_data)} license records")
        print(f"🔍 Products extracted: {foscos_data['products_extracted']}")
        print("Keeping browser open for 30 seconds for manual inspection...")
        
        for i in range(30, 0, -5):
            print(f"⏰ Browser will close in {i} seconds...")
            time.sleep(3)
            
        return final_data
        
    except Exception as e:
        print(f"❌ Error during automation: {e}")
        print("Keeping browser open for debugging...")
        time.sleep(5)
        return foscos_data
        
    finally:
        try:
            driver.quit()
            print("Browser closed.")
        except:
            pass

if __name__ == "__main__":
    product_url = "https://www.avvatarindia.com/product/alpha-whey-belgian-chocolate-flavour-2-kg"
    print(f"Extracting license info from {product_url} ...")
    result = extract_license_with_llm(product_url)
    print(json.dumps(result, indent=4))

    license_number = result.get("license_number")
    if license_number:
        print(f"License number extracted: {license_number}")
        foscos_result = automate_foscos_form(license_number)
        print("Final FoSCoS Result:")
        print(json.dumps(foscos_result, indent=2))
    else:
        print("License number could not be extracted.")