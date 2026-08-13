# Innar Gestión

Sistema de archivo institucional del Instituto Neurociencias de Nariño IPS S.A.S.

## Arranque local

1. MySQL de XAMPP debe estar en ejecución.
2. `npm install`
3. `npm start`
4. Abrir http://localhost:3001

El acceso no usa contraseña fija. Se envía una **contraseña temporal de un solo uso** al correo, válida 10 minutos.

En este PC, si aún no hay SMTP, el código aparece en pantalla. Correo local: `admin@innar.local` (o el valor de `ADMIN_EMAIL` en `.env`).

Para correo real (Hostinger), complete `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` y `SMTP_FROM` en `.env`.
