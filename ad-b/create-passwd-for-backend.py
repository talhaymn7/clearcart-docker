import bcrypt

password = "REMOVED-PASSWORD".encode('utf-8')

# 12 rounds (cost factor) ile salt oluştur ve hash'le
hashed = bcrypt.hashpw(password, bcrypt.gensalt(rounds=12))

print(hashed.decode('utf-8'))