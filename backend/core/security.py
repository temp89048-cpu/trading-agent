import base64
import os
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

class SecurityManager:
    """
    Level 14: Security
    Provides API key encryption at rest. Never store raw API keys in DB or logs.
    """
    def __init__(self, master_password: str):
        # Generate a deterministic key from a master password for simplicity
        salt = b"trading_os_salt"
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=480000,
        )
        key = base64.urlsafe_b64encode(kdf.derive(master_password.encode()))
        self.fernet = Fernet(key)

    def encrypt_key(self, api_key: str) -> str:
        return self.fernet.encrypt(api_key.encode()).decode()

    def decrypt_key(self, encrypted_key: str) -> str:
        return self.fernet.decrypt(encrypted_key.encode()).decode()

# In production, this master password would come from an environment variable injected by K8s or Docker Swarm secrets
_master_pass = os.getenv("MASTER_PASSWORD", "default_insecure_master")
_security = SecurityManager(_master_pass)

def get_security_manager() -> SecurityManager:
    return _security
