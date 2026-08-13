# Güvenlik Politikası

## Zafiyet Bildirimi

Bir güvenlik açığı bulduysanız **lütfen public issue açmayın.**

GitHub üzerinden [Security Advisory](../../security/advisories/new) oluşturun.
Bildiriminize şunları eklerseniz doğrulama hızlanır: etkilenen uç/dosya, yeniden üretme adımları
ve etkinin kısa tarifi.

İlk yanıt için hedef süre: 7 gün.

## Güvenlik Modeli

### Kimlik doğrulama
- JWT'ler **RS256** ile imzalanır. Anahtar çiftleri imaj build'i sırasında üretilir ve repoya girmez.
- Kullanıcı backend'i ve admin backend'i **birbirinden bağımsız anahtar çiftleri** kullanır.
  Bu kasıtlıdır: aynı anahtar paylaşılırsa sıradan bir kullanıcı token'ı admin uçlarında da geçerli
  imzaya sahip olur. `backend/keys` dizinini admin servisine mount etmeyin.
- Admin token'ları `role: "admin"` taşır ve her istekte hesabın `adm_users` tablosunda hâlâ var olduğu
  doğrulanır. İmzanın geçerli olması tek başına yetki için yeterli sayılmaz.
- Şifreler bcrypt (cost 12) ile saklanır.

### Yetkilendirme
- `/admin/v1` altındaki **tüm** uçlar varsayılan olarak kimlik doğrulaması ister; yalnızca
  `/admin/v1/login` açıkça beyaz listededir. Yeni bir uç eklendiğinde yetkilendirme unutulamaz.
- Nginx'teki Basic Auth ek bir katmandır, uygulama yetkilendirmesinin yerine geçmez.

### Dosya yükleme
- Uzantı beyaz listeye karşı doğrulanır (`.jpg`, `.jpeg`, `.png`, `.webp`). İstemcinin gönderdiği
  `originalname` ve `mimetype` değerlerine güvenilmez.
- Dosya adları sunucu tarafında rastgele UUID ile üretilir; istek parametreleri dosya adına karışmaz.
- Hedef yolun izin verilen dizin içinde kaldığı `path.resolve` ile ayrıca doğrulanır.
- Statik olarak sunulan görsellere `X-Content-Type-Options: nosniff` ve kısıtlayıcı bir CSP eklenir.
- Kullanıcıların yüklediği feedback görselleri statik olarak sunulmaz; yalnızca sahibi (veya admin)
  kimlik doğrulamalı uçtan erişebilir.

### Oran sınırlama
- Kimlik doğrulama uçlarında 15 dakikada 10 istek, genel trafikte 15 dakikada 300 istek.

## Kendi Kurulumunuz İçin Kontrol Listesi

- [ ] `.env` dosyası oluşturuldu ve **hiçbir gizli değer** `docker-compose.yml`'e yazılmadı
- [ ] `nginx/.htpasswd` **bcrypt** ile üretildi (`htpasswd -B`), MD5 ile değil
- [ ] Admin şifreleri en az 12 karakter
- [ ] PostgreSQL portu dışarıya açık değil (`expose`, `ports` değil)
- [ ] NGROK yalnızca geliştirme ortamında çalışıyor
- [ ] Üretimde HTTPS sonlandırması yapılandırıldı (bu depo yalnızca HTTP dinler)
- [ ] Veritabanı yedekleri (`.sql`) repo dışında tutuluyor — kişisel veri içerirler

## Bilinen Sınırlar

- Bu depo TLS sonlandırması içermez; üretimde önüne HTTPS yapan bir katman koyun.
- Token iptali (revocation) uygulanmamıştır: JWT'ler süreleri dolana kadar geçerlidir.
  Acil durumda ilgili servisin RSA anahtar çiftini yenileyerek tüm token'ları geçersiz kılabilirsiniz.
- `computeEmbeddingsAndBuildIndex.js` ve `buildIndex.js` eski Turso/libSQL bağlantısını kullanır
  ve aktif PostgreSQL veritabanıyla çalışmaz.
