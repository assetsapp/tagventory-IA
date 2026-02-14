# Tagventory Backend

Backend mínimo con MongoDB Atlas y OpenAI. Incluye endpoints de prueba para validar conexiones.

## Requisitos

- Node.js 18 LTS o superior

## Configuración

1. Copia el archivo de ejemplo de variables de entorno:

```bash
cp .env.example .env
```

2. Edita `.env` y completa las variables:

| Variable | Descripción |
|----------|-------------|
| `PORT` | Puerto del servidor (default: 3000) |
| `MONGO_URI` | URI de conexión a MongoDB Atlas |
| `DB_NAME` | Nombre de la base de datos |
| `OPENAI_API_KEY` | API Key de OpenAI |

**Nota:** Si la contraseña de MongoDB contiene caracteres especiales (ej: `@`), debes codificarlos en URL. Por ejemplo: `@` → `%40`.

## Instalación

```bash
npm install
```

## Ejecución

```bash
npm run dev
```

El servidor se inicia en `http://localhost:3000` (o el puerto configurado).

## Endpoints

### GET /health

Comprueba que el servidor y MongoDB están operativos.

**Ejemplo con curl:**

```bash
curl http://localhost:3000/health
```

**Respuesta exitosa (200):**

```json
{
  "status": "ok",
  "mongo": "ok",
  "dbName": "tagventory",
  "timestamp": "2025-02-13T12:00:00.000Z"
}
```

**Respuesta error MongoDB (500):**

```json
{
  "status": "error",
  "mongo": "fail",
  "message": "Error al conectar con MongoDB"
}
```

### POST /ai/embedding

Genera un embedding de texto usando OpenAI y devuelve las dimensiones y una vista previa.

**Ejemplo con curl:**

```bash
curl -X POST http://localhost:3000/ai/embedding \
  -H "Content-Type: application/json" \
  -d '{"text": "Hola mundo, este es un texto de prueba"}'
```

**Respuesta exitosa (200):**

```json
{
  "dims": 1536,
  "preview": [0.0123, -0.0456, 0.0789, -0.0123, 0.0456]
}
```

**Respuesta error validación (400):**

```json
{
  "status": "error",
  "message": "El campo \"text\" es requerido y no puede estar vacío"
}
```

## Estructura del proyecto

```
src/
├── config/
│   ├── env.js       # Carga y validación de variables de entorno
│   ├── mongo.js     # Conexión MongoDB
│   └── openai.js    # Cliente OpenAI
├── controllers/
│   ├── health.controller.js
│   └── ai.controller.js
├── routes/
│   ├── health.routes.js
│   └── ai.routes.js
├── services/
│   └── embedding.service.js
└── index.js
```
