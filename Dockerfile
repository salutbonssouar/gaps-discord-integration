FROM node:alpine3.19

WORKDIR /app
COPY package.json .
RUN npm i && npm i typescript -g
COPY . .
RUN tsc

COPY crontab /var/spool/cron/crontabs/

CMD ["crond", "-f"]
