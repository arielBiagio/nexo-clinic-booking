# Nexo

## Funciones

- Login del personal con roles de administración, recepción y terapeuta.
- Alta de terapeutas con su perfil profesional, gestión de roles y desactivación de accesos.
- Terapeutas: edición de su perfil y disponibilidad, creación y cancelación de reservas de su propia agenda.
- Agenda semanal y diaria con filtros, búsqueda y reservas manuales sobre fichas existentes.
- Asistente de reservas con lenguaje natural, consulta de disponibilidad, preferencias de primera/última hora y explicaciones con IA.
- Selección de horarios y confirmación de reservas controladas por el backend.
- Ficha del paciente con nombre, teléfono, seguro y resumen de información referida.
- Bandeja de conversaciones, atención humana y reanudación del asistente.
- Historial de mensajes y contexto de reservas persistentes, con protección contra mensajes duplicados.
- Reservas por Telegram en chats privados de prueba, con botones y respuestas de recepción.
- Reprogramación por chat o desde la agenda, conservando la reserva y los datos del paciente.
- Cancelación por chat con elección del turno y confirmación explícita.
- Avisos por conversación con atención humana pendiente y campana con actividad de turnos.
- Configuración de jornadas, descansos, duración de sesiones y ausencias.
- Cancelación y restauración de turnos; archivo y recuperación de conversaciones.
- Fichas y reservas compartidas en Supabase, con protección contra turnos superpuestos; modo local opcional.

## Tecnologías

- TypeScript y Node.js.
- React, Vite y Lucide.
- Fastify y Zod.
- Supabase Auth, PostgreSQL, PGlite y migraciones SQL.
- OpenRouter con GPT-4o mini.
- Telegram Bot API mediante long polling y cola persistente de envíos.
- Temporal para fechas, horarios y zonas horarias.
