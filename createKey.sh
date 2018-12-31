#!/bin/sh
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes
openssl rsa -in key.pem -out newkey.pem && mv newkey.pem key.pem
