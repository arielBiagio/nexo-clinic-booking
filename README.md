# Nexo

## Funciones

- Login del personal con roles de administración, recepción y terapeuta.
- Alta de terapeutas con su perfil profesional, gestión de roles y desactivación de accesos.
- Terapeutas: edición de su perfil y disponibilidad, creación y cancelación de reservas de su propia agenda.
- Agenda semanal y diaria con filtros, búsqueda flexible por nombres y reservas manuales sobre fichas existentes.
- Asistente de reservas con lenguaje natural, consulta de disponibilidad, preferencias de primera/última hora y explicaciones con IA.
- Selección de horarios y confirmación de reservas controladas por el backend.
- Ficha del paciente con nombre, teléfono, seguro y resumen de información referida.
- Bandeja de conversaciones, atención humana y reanudación del asistente.
- Historial de mensajes y contexto de reservas persistentes, con protección contra mensajes duplicados.
- Reservas por Telegram en chats privados de prueba, con botones y respuestas de recepción.
- Comando /nuevo_paciente para iniciar pruebas con fichas independientes desde una cuenta de Telegram autorizada.
- Reprogramación por chat o desde la agenda, conservando la reserva y los datos del paciente.
- Cancelación por chat con elección del turno y confirmación explícita.
- Reservas de una semana al mismo horario, con revisión de cada fecha, contacto y confirmación del conjunto.
- Cancelación conjunta de los turnos futuros de una semana, con revisión y confirmación.
- Google Calendar por terapeuta: conexión OAuth y copia de turnos, cambios y cancelaciones en un calendario propio.
- Datos de la ficha en Google Calendar, avisos de nuevos eventos por correo y recordatorios 30 minutos antes.
- Avisos por conversación con atención humana pendiente y campana con actividad de turnos.
- Ajustes personales de notificaciones del navegador y sonidos, con acceso para cerrar sesión.
- Modo claro y oscuro Obsidiana, con preferencia guardada.
- Animaciones breves de navegación y entradas escalonadas, con movimiento reducido según el sistema.
- Accesos rápidos para crear turnos o administrar accesos del equipo.
- Configuración de jornadas, descansos, duración de sesiones y ausencias.
- Cancelación y restauración de turnos; archivo y recuperación de conversaciones.
- Fichas y reservas compartidas en Supabase, con protección contra turnos superpuestos; modo local opcional.

## Tecnologías

- TypeScript y Node.js.
- React, Vite y Lucide.
- Fastify y Zod.
- Supabase Auth, PostgreSQL, PGlite y migraciones SQL.
- OpenRouter con GPT-6 Luna.
- Telegram Bot API mediante long polling y cola persistente de envíos.
- Google Calendar API y OAuth 2.0, con sincronización persistente en segundo plano.
- Temporal para fechas, horarios y zonas horarias.
