# Расписание Политеха

Небольшое приложение: Node.js-сервер забирает расписание с rasp.dmami.ru,
приводит к единому формату и кэширует на 15 минут, а страница показывает неделю.

## Запуск

    node server.js        # нужен Node.js 18+, зависимостей нет
    # открыть http://localhost:3000

## Как устроено

- `GET /api/groups` — список групп (для подсказок в поле ввода).
- `GET /api/schedule?group=181-362&session=0` — занятия группы (`session=1` — сессия).
- Сервер нужен, потому что rasp.dmami.ru не отдаёт CORS-заголовки и требует Referer.

## Если данные не приходят

Адреса API сайта могут меняться. Откройте rasp.dmami.ru, DevTools → Network,
найдите запрос после ввода группы и задайте актуальные пути:

    RASP_GROUP_PATH=/site/group RASP_GROUPS_PATH=/semester.json node server.js

Формат ответа разбирает функция `normalize` в `server.js`.
