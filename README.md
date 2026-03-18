# Facebook Bot for Railway

بوت Facebook Messenger احترافي مع لوحة تحكم ويب داخلية، جاهز للنشر على `Railway`.

## المميزات

- Webhook جاهز لاستقبال رسائل Messenger.
- لوحة تحكم عربية لتشغيل وإيقاف البوت.
- رسالة ترحيب ورد افتراضي قابلان للتعديل.
- قواعد كلمات مفتاحية مع ردود مخصصة.
- إرسال رسالة مباشرة لمستخدم محدد.
- بث جماعي للمستخدمين النشطين خلال آخر 24 ساعة.
- حفظ السجل والإعدادات داخل ملفات JSON مع إمكانية ربط Volume في Railway للاستمرارية.

## التشغيل محليًا

```bash
npm install
npm start
```

ثم افتح:

```text
http://localhost:3000
```

## النشر على Railway

1. ارفع المشروع إلى Railway.
2. أضف المتغيرات التالية داخل Railway Variables:
   - `PAGE_ACCESS_TOKEN`
   - `PAGE_ID`
   - `VERIFY_TOKEN`
   - `DASHBOARD_PASSWORD`
   - `DATA_DIR=/app/.data` إذا لم تستخدم Volume
3. انشر المشروع.
4. فعّل Public Networking للخدمة.
5. إذا أردت حفظ البيانات بعد إعادة التشغيل، أنشئ Volume واربطه بالخدمة على مسار `/app/.data`.
6. بعد حصول الخدمة على رابط عام من Railway، سيتعرف التطبيق عليه تلقائيًا عبر `RAILWAY_PUBLIC_DOMAIN`. ويمكنك أيضًا ضبط `APP_URL` يدويًا إذا رغبت.
7. افتح `/setup` من داخل اللوحة وستجد:
   - رابط الـ Webhook
   - Verify Token
8. ضع بيانات Webhook داخل Meta Developers ثم فعّل اشتراك الصفحة في الرسائل.

## ربط Meta Developers

1. افتح تطبيقك في Meta Developers.
2. أضف منتج `Messenger`.
3. افتح إعدادات `Webhooks`.
4. في `Callback URL` ضع:
   - `https://YOUR-RAILWAY-DOMAIN.up.railway.app/webhook`
5. في `Verify Token` ضع نفس قيمة `VERIFY_TOKEN`.
6. بعد نجاح التحقق، اشترك في أحداث الصفحة المطلوبة وأهمها:
   - `messages`
   - `messaging_postbacks`
7. ارجع إلى Messenger ثم اربط الصفحة التي رقمها `108133832082057` بالتطبيق إذا لم تكن مرتبطة.
8. تأكد أن الـ Page Access Token المستخدم هو الخاص بنفس الصفحة.

## ملاحظة مهمة

للاحتفاظ بالإعدادات بعد إعادة التشغيل في Railway، اربط Volume بالمشروع على `/app/.data`. التطبيق أصبح يدعم أيضًا `RAILWAY_VOLUME_MOUNT_PATH` تلقائيًا.
