# MTG Store frontend

React and TypeScript interface for the MTG Store proof of concept.

From the repository root:

```bash
npm --prefix frontend ci
npm --prefix frontend run dev
```

The frontend uses `http://localhost:8000` by default. To use another API:

```bash
cp frontend/.env.example frontend/.env
```

Then change `VITE_API_URL` in `frontend/.env`.
